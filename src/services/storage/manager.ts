import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'
import type { Readable } from 'node:stream'
import type { StorageConfig } from '../../config.js'
import { AppError } from '../../core/errors.js'
import { BackupService, type BackupInfo, type BackupResult } from './backup.js'
import { StorageCleaner, type CleanReport } from './cleaner.js'
import { StorageMonitor, type BlobUsage, type StorageEvent, type StorageSnapshot, type TableUsage } from './monitor.js'
import { OPEN_POLICY, formatBytes, levelRank, policyFor, type Forecast, type StorageGuard, type StorageLevel, type StoragePolicy } from './policy.js'

export type MaintainMode = 'auto' | 'aggressive'

export interface MaintenanceResult {
  mode: MaintainMode
  level: StorageLevel
  skipped: boolean
  beforeBytes: number | null
  afterBytes: number | null
  report: CleanReport | null
}

export interface StorageStatus {
  enabled: boolean
  serverless: boolean
  usedBytes: number | null
  limitBytes: number
  usedPercent: number | null
  level: StorageLevel
  thresholds: StorageConfig['thresholds']
  policy: StoragePolicy
  forecast: Forecast | null
  tables: TableUsage[]
  blobs: BlobUsage | null
  backups: { enabled: boolean; dir: string; items: BackupInfo[] }
  lastMaintenance: StorageEvent | null
  checkedAt: string | null
}

const HOUR_MS = 3_600_000
const FIRST_TICK_MS = 20_000

export class StorageManager implements StorageGuard {
  readonly monitor: StorageMonitor
  readonly backups: BackupService
  private readonly cleaner: StorageCleaner
  private timer?: NodeJS.Timeout
  private first?: NodeJS.Timeout
  private ticking = false
  private maintaining: Promise<MaintenanceResult> | null = null
  private lastMaintenance = 0
  private lastSample = 0
  private lastBackup = 0

  constructor(
    pool: Pool,
    private readonly log: FastifyBaseLogger,
    private readonly cfg: StorageConfig,
    private readonly serverless = false
  ) {
    this.monitor = new StorageMonitor(pool, log, {
      limitBytes: cfg.limitBytes,
      thresholds: cfg.thresholds,
      sampleTtlMs: cfg.sampleTtlMs,
      alertWebhookUrl: cfg.alertWebhookUrl,
      alertCooldownMs: cfg.alertCooldownMs
    })
    this.cleaner = new StorageCleaner(pool, cfg.limitBytes)
    this.backups = new BackupService(pool, cfg.backup)
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  async policy(): Promise<StoragePolicy> {
    if (!this.cfg.enabled) return OPEN_POLICY
    return this.monitor.policy()
  }

  start(): void {
    if (!this.cfg.enabled || this.serverless || this.timer) return
    void this.initBackupClock()
    this.first = setTimeout(() => void this.tick(), FIRST_TICK_MS)
    this.first.unref()
    this.timer = setInterval(() => void this.tick(), this.cfg.checkEveryMs)
    this.timer.unref()
  }

  stop(): void {
    clearTimeout(this.first)
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async initBackupClock(): Promise<void> {
    const newest = (await this.backups.list().catch(() => []))[0]
    this.lastBackup = newest ? Date.parse(newest.createdAt) : Date.now() - this.cfg.backup.everyMs + this.cfg.backup.firstDelayMs
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const snap = await this.monitor.refresh()
      if (!snap) return
      const now = Date.now()
      if (now - this.lastSample >= HOUR_MS) {
        this.lastSample = now
        await this.monitor.event('sample')
        await this.monitor.checkForecast()
      }
      const pressure = levelRank(snap.level) >= levelRank('warning')
      if (now - this.lastMaintenance >= (pressure ? this.cfg.pressureEveryMs : this.cfg.routineEveryMs)) {
        await this.maintain('auto').catch(e => this.log.warn({ err: (e as Error).message }, 'storage maintenance failed'))
      }
      if (this.cfg.backup.enabled && now - this.lastBackup >= this.cfg.backup.everyMs) {
        this.lastBackup = now
        await this.backup().catch(e => this.log.warn({ err: (e as Error).message }, 'scheduled backup failed'))
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'storage tick failed')
    } finally {
      this.ticking = false
    }
  }

  maintain(mode: MaintainMode = 'auto'): Promise<MaintenanceResult> {
    if (!this.maintaining) {
      this.maintaining = this.runMaintenance(mode).finally(() => {
        this.maintaining = null
      })
    }
    return this.maintaining
  }

  private async runMaintenance(mode: MaintainMode): Promise<MaintenanceResult> {
    if (!this.cfg.enabled) return { mode, level: 'ok', skipped: true, beforeBytes: null, afterBytes: null, report: null }
    const before = await this.monitor.refresh()
    const level: StorageLevel = mode === 'aggressive' ? 'critical' : this.monitor.level
    const report = await this.cleaner.run(policyFor(level))
    this.lastMaintenance = Date.now()
    if (report.locked) {
      return { mode, level, skipped: true, beforeBytes: before?.usedBytes ?? null, afterBytes: before?.usedBytes ?? null, report }
    }
    const after = await this.monitor.refresh()
    const result: MaintenanceResult = { mode, level, skipped: false, beforeBytes: before?.usedBytes ?? null, afterBytes: after?.usedBytes ?? null, report }
    this.log.info({ mode, level, before: before?.usedBytes, after: after?.usedBytes, steps: report.steps }, 'storage maintenance done')
    await this.monitor.event('maintenance', { mode, level, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes, steps: report.steps })
    await this.warnIfStillHigh(after)
    return result
  }

  private async warnIfStillHigh(after: StorageSnapshot | null): Promise<void> {
    if (!after || levelRank(after.level) < levelRank('high')) return
    const text = `[Koyami] Pembersihan otomatis selesai tetapi storage masih ${formatBytes(after.usedBytes)} dari ${formatBytes(after.limitBytes)} (${(after.ratio * 100).toFixed(1)}%). Sisanya kemungkinan data pengguna (foto profil, komentar, pustaka); tinjau di panel admin atau naikkan kapasitas database.`
    this.log.error({ usedBytes: after.usedBytes, level: after.level }, text)
    await this.monitor.alert('still-high', text)
  }

  async backup(): Promise<BackupResult> {
    if (this.serverless) {
      throw new AppError(501, 'NOT_CONFIGURED', 'Backup ke disk tidak tersedia di mode serverless; gunakan endpoint export')
    }
    const result = await this.backups.create()
    this.lastBackup = Date.now()
    this.log.info({ name: result.name, bytes: result.bytes, counts: result.counts, removed: result.removed }, 'backup created')
    await this.monitor.event('backup', { name: result.name, bytes: result.bytes, counts: result.counts, removed: result.removed })
    return result
  }

  exportStream(): Promise<Readable> {
    return this.backups.exportStream()
  }

  async status(): Promise<StorageStatus> {
    const snap = (await this.monitor.refresh()) ?? this.monitor.current()
    const [tables, blobs, items, forecast, lastMaintenance] = await Promise.all([
      this.monitor.tables(60).catch(() => [] as TableUsage[]),
      this.monitor.blobs().catch(() => null),
      this.backups.list().catch(() => [] as BackupInfo[]),
      this.monitor.forecast().catch(() => null),
      this.monitor.events(1, 'maintenance').then(r => r[0] ?? null).catch(() => null)
    ])
    return {
      enabled: this.cfg.enabled,
      serverless: this.serverless,
      usedBytes: snap?.usedBytes ?? null,
      limitBytes: this.cfg.limitBytes,
      usedPercent: snap ? Number((snap.ratio * 100).toFixed(2)) : null,
      level: this.monitor.level,
      thresholds: this.cfg.thresholds,
      policy: policyFor(this.monitor.level),
      forecast,
      tables,
      blobs,
      backups: { enabled: this.cfg.backup.enabled, dir: this.cfg.backup.dir, items },
      lastMaintenance,
      checkedAt: snap ? new Date(snap.at).toISOString() : null
    }
  }

  events(limit: number, kind?: string): Promise<StorageEvent[]> {
    return this.monitor.events(limit, kind)
  }
}

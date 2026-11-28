import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'
import {
  forecast,
  formatBytes,
  levelRank,
  nextLevel,
  policyFor,
  type Forecast,
  type Sample,
  type StorageGuard,
  type StorageLevel,
  type StoragePolicy,
  type Thresholds
} from './policy.js'

export interface MonitorOptions {
  limitBytes: number
  thresholds: Thresholds
  sampleTtlMs: number
  alertWebhookUrl: string
  alertCooldownMs: number
}

export interface StorageSnapshot {
  at: number
  usedBytes: number
  limitBytes: number
  ratio: number
  level: StorageLevel
}

export interface TableUsage {
  name: string
  totalBytes: number
  heapBytes: number
  indexBytes: number
  toastBytes: number
  rows: number
  deadRows: number
}

export interface BlobUsage {
  avatars: { count: number; bytes: number }
}

export interface StorageEvent {
  id: number
  createdAt: string
  kind: string
  level: string | null
  dbBytes: number | null
  detail: Record<string, unknown>
}

const TABLES_SQL = `
SELECT c.relname AS name,
       pg_total_relation_size(c.oid)::bigint AS total,
       pg_relation_size(c.oid)::bigint AS heap,
       pg_indexes_size(c.oid)::bigint AS indexes,
       GREATEST(pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid), 0)::bigint AS toast,
       GREATEST(c.reltuples, 0)::bigint AS rows,
       COALESCE(s.n_dead_tup, 0)::bigint AS dead
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY total DESC
LIMIT $1`

const BLOBS_SQL = `
SELECT
  (SELECT count(avatar) FROM users)::int AS avatars,
  (SELECT COALESCE(sum(pg_column_size(avatar)), 0) FROM users)::bigint AS avatar_bytes`

const percent = (snap: StorageSnapshot) => `${(snap.ratio * 100).toFixed(1)}%`
const describe = (snap: StorageSnapshot) => `${formatBytes(snap.usedBytes)} dari ${formatBytes(snap.limitBytes)} (${percent(snap)})`

export class StorageMonitor implements StorageGuard {
  private snap: StorageSnapshot | null = null
  private inflight: Promise<StorageSnapshot | null> | null = null
  private currentLevel: StorageLevel = 'ok'
  private readonly alerted = new Map<string, number>()

  constructor(
    private readonly pool: Pool,
    private readonly log: FastifyBaseLogger,
    private readonly opts: MonitorOptions
  ) {}

  get level(): StorageLevel {
    return this.currentLevel
  }

  current(): StorageSnapshot | null {
    return this.snap
  }

  async policy(): Promise<StoragePolicy> {
    await this.fresh()
    return policyFor(this.currentLevel)
  }

  private async fresh(): Promise<void> {
    if (this.snap && Date.now() - this.snap.at < this.opts.sampleTtlMs) return
    let timer: NodeJS.Timeout | undefined
    const limit = new Promise<void>(resolve => {
      timer = setTimeout(resolve, 1_500)
    })
    await Promise.race([this.refresh(), limit])
    clearTimeout(timer)
  }

  refresh(): Promise<StorageSnapshot | null> {
    if (!this.inflight) {
      this.inflight = this.measure().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  private async measure(): Promise<StorageSnapshot | null> {
    try {
      const { rows } = await this.pool.query<{ bytes: string }>('SELECT pg_database_size(current_database())::bigint AS bytes')
      const usedBytes = Number(rows[0]?.bytes)
      if (!Number.isFinite(usedBytes)) return this.snap
      const ratio = usedBytes / this.opts.limitBytes
      const previous = this.currentLevel
      const level = nextLevel(previous, ratio, this.opts.thresholds)
      this.snap = { at: Date.now(), usedBytes, limitBytes: this.opts.limitBytes, ratio, level }
      this.currentLevel = level
      if (level !== previous) await this.onLevelChange(previous, level, this.snap)
      return this.snap
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'storage measure failed')
      return this.snap
    }
  }

  private async onLevelChange(previous: StorageLevel, next: StorageLevel, snap: StorageSnapshot): Promise<void> {
    try {
      const rising = levelRank(next) > levelRank(previous)
      const text = `Storage database ${describe(snap)}: level ${previous} -> ${next}`
      if (rising && next === 'critical') this.log.error({ level: next, usedBytes: snap.usedBytes }, text)
      else if (rising && levelRank(next) >= levelRank('warning')) this.log.warn({ level: next, usedBytes: snap.usedBytes }, text)
      else this.log.info({ level: next, usedBytes: snap.usedBytes }, text)
      await this.event('level', { from: previous, to: next, percent: Number((snap.ratio * 100).toFixed(2)) })
      if (rising && levelRank(next) >= levelRank('warning')) {
        await this.alert(next, `[MiToon] ${text}. Pembersihan otomatis dijalankan; jika tetap tinggi, periksa data pengguna terbesar di panel admin.`)
      } else if (!rising && levelRank(previous) >= levelRank('warning') && levelRank(next) < levelRank('warning')) {
        await this.alert('ok', `[MiToon] Storage database kembali aman: ${describe(snap)}`, true)
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'storage level notification failed')
    }
  }

  async alert(key: string, text: string, force = false): Promise<void> {
    const url = this.opts.alertWebhookUrl
    if (!url) return
    const last = this.alerted.get(key) ?? 0
    if (!force && Date.now() - last < this.opts.alertCooldownMs) return
    this.alerted.set(key, Date.now())
    const snap = this.snap
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          content: text,
          level: this.currentLevel,
          usedBytes: snap?.usedBytes ?? null,
          limitBytes: this.opts.limitBytes,
          percent: snap ? Number((snap.ratio * 100).toFixed(2)) : null
        }),
        signal: AbortSignal.timeout(5_000)
      })
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'storage alert webhook failed')
    }
  }

  async event(kind: string, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.pool.query('INSERT INTO storage_events (kind, level, db_bytes, detail) VALUES ($1, $2, $3, $4::jsonb)', [
        kind,
        this.currentLevel,
        this.snap?.usedBytes ?? null,
        JSON.stringify(detail)
      ])
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'storage event write failed')
    }
  }

  async events(limit = 50, kind?: string): Promise<StorageEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT id, created_at, kind, level, db_bytes, detail FROM storage_events WHERE ($2::text IS NULL OR kind = $2::text) ORDER BY id DESC LIMIT $1`,
      [limit, kind ?? null]
    )
    return rows.map(r => ({
      id: Number(r.id),
      createdAt: new Date(r.created_at).toISOString(),
      kind: String(r.kind),
      level: (r.level as string | null) ?? null,
      dbBytes: r.db_bytes == null ? null : Number(r.db_bytes),
      detail: (r.detail ?? {}) as Record<string, unknown>
    }))
  }

  async tables(limit = 15): Promise<TableUsage[]> {
    const { rows } = await this.pool.query(TABLES_SQL, [limit])
    return rows.map(r => ({
      name: String(r.name),
      totalBytes: Number(r.total),
      heapBytes: Number(r.heap),
      indexBytes: Number(r.indexes),
      toastBytes: Number(r.toast),
      rows: Number(r.rows),
      deadRows: Number(r.dead)
    }))
  }

  async blobs(): Promise<BlobUsage> {
    const { rows } = await this.pool.query(BLOBS_SQL)
    const r = rows[0] ?? {}
    return {
      avatars: { count: Number(r.avatars ?? 0), bytes: Number(r.avatar_bytes ?? 0) }
    }
  }

  async forecast(): Promise<Forecast> {
    const { rows } = await this.pool.query(
      `SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS at, db_bytes
         FROM storage_events
        WHERE kind = 'sample' AND db_bytes IS NOT NULL AND created_at > now() - interval '24 hours'
        ORDER BY id`
    )
    const samples: Sample[] = rows.map(r => ({ at: Number(r.at), bytes: Number(r.db_bytes) }))
    return forecast(samples, this.opts.limitBytes, this.opts.thresholds.critical)
  }

  async checkForecast(): Promise<void> {
    if (levelRank(this.currentLevel) >= levelRank('high')) return
    const f = await this.forecast()
    if (f.hoursToCritical === null || f.hoursToCritical > 24) return
    const hours = Math.max(1, Math.round(f.hoursToCritical))
    const text = `[MiToon] Perkiraan storage database mencapai level kritis dalam ±${hours} jam (naik ${formatBytes(f.bytesPerHour)}/jam). Periksa pertumbuhan tabel di panel admin.`
    this.log.warn({ hoursToCritical: f.hoursToCritical, bytesPerHour: f.bytesPerHour }, text)
    await this.event('forecast', { hoursToCritical: f.hoursToCritical, bytesPerHour: f.bytesPerHour })
    await this.alert('forecast', text)
  }
}

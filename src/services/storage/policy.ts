import { AppError } from '../../core/errors.js'

export const STORAGE_LEVELS = ['ok', 'notice', 'warning', 'high', 'critical'] as const
export type StorageLevel = (typeof STORAGE_LEVELS)[number]

export interface Thresholds {
  notice: number
  warning: number
  high: number
  critical: number
}

export const DEFAULT_THRESHOLDS: Thresholds = { notice: 0.7, warning: 0.8, high: 0.9, critical: 0.95 }

const HYSTERESIS = 0.02
const HOUR_MS = 3_600_000

export const levelRank = (level: StorageLevel) => STORAGE_LEVELS.indexOf(level)

export function levelFor(ratio: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): StorageLevel {
  if (ratio >= thresholds.critical) return 'critical'
  if (ratio >= thresholds.high) return 'high'
  if (ratio >= thresholds.warning) return 'warning'
  if (ratio >= thresholds.notice) return 'notice'
  return 'ok'
}

export function nextLevel(previous: StorageLevel, ratio: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): StorageLevel {
  const raw = levelFor(ratio, thresholds)
  if (levelRank(raw) >= levelRank(previous)) return raw
  return levelRank(levelFor(ratio + HYSTERESIS, thresholds)) >= levelRank(previous) ? previous : raw
}

export interface StoragePolicy {
  level: StorageLevel
  crawl: 'full' | 'light' | 'off'
  enrichScale: number
  catalogWrites: boolean
  chapterWrites: 'all' | 'existing' | 'none'
  blobScale: number
  viewRetentionDays: number
  xpLedgerDays: number
  coldChapterDays: number
  protectRecentDetailDays: number
  staleSeriesDays: number | null
}

const POLICIES: Record<StorageLevel, Omit<StoragePolicy, 'level'>> = {
  ok: { crawl: 'full', enrichScale: 1, catalogWrites: true, chapterWrites: 'all', blobScale: 1, viewRetentionDays: 90, xpLedgerDays: 60, coldChapterDays: 90, protectRecentDetailDays: 3, staleSeriesDays: null },
  notice: { crawl: 'full', enrichScale: 1, catalogWrites: true, chapterWrites: 'all', blobScale: 1, viewRetentionDays: 90, xpLedgerDays: 60, coldChapterDays: 60, protectRecentDetailDays: 3, staleSeriesDays: null },
  warning: { crawl: 'light', enrichScale: 0.5, catalogWrites: true, chapterWrites: 'all', blobScale: 0.5, viewRetentionDays: 60, xpLedgerDays: 45, coldChapterDays: 30, protectRecentDetailDays: 3, staleSeriesDays: 120 },
  high: { crawl: 'off', enrichScale: 0, catalogWrites: true, chapterWrites: 'existing', blobScale: 0.25, viewRetentionDays: 45, xpLedgerDays: 30, coldChapterDays: 14, protectRecentDetailDays: 1, staleSeriesDays: 60 },
  critical: { crawl: 'off', enrichScale: 0, catalogWrites: false, chapterWrites: 'none', blobScale: 0, viewRetentionDays: 30, xpLedgerDays: 14, coldChapterDays: 3, protectRecentDetailDays: 0, staleSeriesDays: 30 }
}

export const policyFor = (level: StorageLevel): StoragePolicy => ({ level, ...POLICIES[level] })

export const OPEN_POLICY: StoragePolicy = policyFor('ok')

export interface StorageGuard {
  policy(): Promise<StoragePolicy>
}

export async function assertBlobAllowed(guard: StorageGuard | undefined, bytes: number, normalMax: number): Promise<void> {
  if (!guard) return
  const policy = await guard.policy()
  if (policy.blobScale >= 1) return
  const allowed = Math.floor(normalMax * policy.blobScale)
  if (allowed <= 0) {
    throw new AppError(507, 'STORAGE_FULL', 'Penyimpanan server hampir penuh, unggah foto profil dinonaktifkan sementara. Coba lagi nanti.')
  }
  if (bytes > allowed) {
    throw new AppError(507, 'STORAGE_LOW', `Penyimpanan server menipis, ukuran maksimal sementara ${Math.floor(allowed / 1024)} KB`)
  }
}

export interface Sample {
  at: number
  bytes: number
}

export interface Forecast {
  bytesPerHour: number
  hoursToCritical: number | null
}

export function forecast(samples: Sample[], limitBytes: number, criticalRatio: number): Forecast {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last || last.at - first.at < HOUR_MS / 2) return { bytesPerHour: 0, hoursToCritical: null }
  const bytesPerHour = ((last.bytes - first.bytes) / (last.at - first.at)) * HOUR_MS
  if (bytesPerHour <= 0) return { bytesPerHour: 0, hoursToCritical: null }
  const remaining = limitBytes * criticalRatio - last.bytes
  return { bytesPerHour, hoursToCritical: remaining <= 0 ? 0 : remaining / bytesPerHour }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${Math.max(0, Math.round(bytes))} B`
}

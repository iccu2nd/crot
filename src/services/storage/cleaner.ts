import type { Pool, PoolClient } from 'pg'
import type { StoragePolicy } from './policy.js'

export interface StepResult {
  step: string
  rows: number
  detail?: string
  error?: string
}

export interface CleanReport {
  locked: boolean
  level: string
  startedAt: string
  finishedAt: string
  steps: StepResult[]
}

type Table = 'series' | 'chapters' | 'series_views' | 'series_genres' | 'chapter_health' | 'announcements' | 'storage_events' | 'xp_events'

const LOCK_ID = 727275
const DELETE_BATCH = 500
const MAX_IDS = 20_000
const FULL_REWRITE_MIN_BYTES = 8_000_000
const FULL_REWRITE_MIN_FRACTION = 0.15

const COLD_SERIES_SQL = `
SELECT s.id FROM series s
WHERE EXISTS (SELECT 1 FROM chapters c WHERE c.series_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM series_views v WHERE v.series_id = s.id AND v.day > CURRENT_DATE - $1::int)
  AND NOT EXISTS (SELECT 1 FROM user_library ul WHERE ul.series_id = s.provider || ':' || s.ref)
  AND NOT EXISTS (SELECT 1 FROM reading_progress rp WHERE rp.series_id = s.provider || ':' || s.ref)
  AND (s.detail_fetched_at IS NULL OR s.detail_fetched_at < now() - make_interval(days => $2::int))
LIMIT $3`

const STALE_SERIES_SQL = `
SELECT s.id FROM series s
WHERE s.last_seen_at < now() - make_interval(days => $1::int)
  AND EXISTS (SELECT 1 FROM series p WHERE p.provider = s.provider AND p.last_seen_at > now() - interval '7 days')
  AND NOT EXISTS (SELECT 1 FROM series_views v WHERE v.series_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM user_library ul WHERE ul.series_id = s.provider || ':' || s.ref)
  AND NOT EXISTS (SELECT 1 FROM reading_progress rp WHERE rp.series_id = s.provider || ':' || s.ref)
LIMIT $2`

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export class StorageCleaner {
  constructor(
    private readonly pool: Pool,
    private readonly limitBytes: number
  ) {}

  async run(policy: StoragePolicy): Promise<CleanReport> {
    const startedAt = new Date().toISOString()
    const client = await this.pool.connect()
    const steps: StepResult[] = []
    let locked = false
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID])
      if (lock.rows[0]?.ok !== true) return { locked: true, level: policy.level, startedAt, finishedAt: new Date().toISOString(), steps }
      locked = true
      await client.query("SET statement_timeout = '180s'")
      await client.query("SET lock_timeout = '5s'")

      await this.attempt(steps, 'series_views', () => this.pruneViews(client, policy))
      await this.attempt(steps, 'chapter_health', () => this.simpleDelete(client, 'chapter_health', "DELETE FROM chapter_health WHERE reported_at < now() - interval '7 days'"))
      await this.attempt(steps, 'announcements', () =>
        this.simpleDelete(
          client,
          'announcements',
          "DELETE FROM announcements WHERE (expires_at IS NOT NULL AND expires_at < now() - interval '60 days') OR (active = false AND created_at < now() - interval '60 days')"
        )
      )
      await this.attempt(steps, 'storage_events', () =>
        this.simpleDelete(client, 'storage_events', "DELETE FROM storage_events WHERE (kind = 'sample' AND created_at < now() - interval '14 days') OR created_at < now() - interval '180 days'")
      )
      await this.attempt(steps, 'xp_events', () => this.simpleDelete(client, 'xp_events', 'DELETE FROM xp_events WHERE day < CURRENT_DATE - $1::int', [policy.xpLedgerDays]))
      await this.attempt(steps, 'cold_chapters', () => this.coldChapters(client, policy))
      await this.attempt(steps, 'stale_series', () => this.staleSeries(client, policy))
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined)
      }
      await client.query('RESET statement_timeout').catch(() => undefined)
      await client.query('RESET lock_timeout').catch(() => undefined)
      client.release()
    }
    return { locked: false, level: policy.level, startedAt, finishedAt: new Date().toISOString(), steps }
  }

  private async attempt(steps: StepResult[], step: string, fn: () => Promise<{ rows: number; detail?: string }>): Promise<void> {
    try {
      const out = await fn()
      steps.push({ step, rows: out.rows, detail: out.detail })
    } catch (e) {
      steps.push({ step, rows: 0, error: (e as Error).message })
    }
  }

  private async simpleDelete(c: PoolClient, table: Table, sql: string, params: unknown[] = []): Promise<{ rows: number; detail?: string }> {
    const res = await c.query(sql, params)
    const rows = res.rowCount ?? 0
    if (rows > 0) await this.vacuum(c, table, false)
    return { rows }
  }

  private async pruneViews(c: PoolClient, policy: StoragePolicy): Promise<{ rows: number }> {
    const res = await c.query('DELETE FROM series_views WHERE day < CURRENT_DATE - $1::int', [policy.viewRetentionDays])
    const rows = res.rowCount ?? 0
    if (rows > 0) await this.vacuum(c, 'series_views', false)
    return { rows }
  }

  private async coldChapters(c: PoolClient, policy: StoragePolicy): Promise<{ rows: number; detail?: string }> {
    const ids = await c.query<{ id: string }>(COLD_SERIES_SQL, [policy.coldChapterDays, policy.protectRecentDetailDays, MAX_IDS])
    const seriesIds = ids.rows.map(r => r.id)
    if (!seriesIds.length) return { rows: 0 }
    const total = await this.count(c, 'chapters')
    let deleted = 0
    for (const part of chunk(seriesIds, DELETE_BATCH)) {
      const res = await c.query('DELETE FROM chapters WHERE series_id = ANY($1::bigint[])', [part])
      deleted += res.rowCount ?? 0
    }
    const mode = await this.reclaim(c, 'chapters', deleted, total, policy)
    return { rows: deleted, detail: `${seriesIds.length} seri, ${mode}` }
  }

  private async staleSeries(c: PoolClient, policy: StoragePolicy): Promise<{ rows: number; detail?: string }> {
    if (policy.staleSeriesDays === null) return { rows: 0, detail: 'dilewati pada level ini' }
    const ids = await c.query<{ id: string }>(STALE_SERIES_SQL, [policy.staleSeriesDays, MAX_IDS])
    const seriesIds = ids.rows.map(r => r.id)
    if (!seriesIds.length) return { rows: 0 }
    const total = await this.count(c, 'series')
    let deleted = 0
    for (const part of chunk(seriesIds, DELETE_BATCH)) {
      const res = await c.query('DELETE FROM series WHERE id = ANY($1::bigint[])', [part])
      deleted += res.rowCount ?? 0
    }
    await this.vacuum(c, 'series_genres', false)
    await this.vacuum(c, 'chapters', false)
    const mode = await this.reclaim(c, 'series', deleted, total, policy)
    return { rows: deleted, detail: mode }
  }

  private async count(c: PoolClient, table: 'series' | 'chapters'): Promise<number> {
    const { rows } = await c.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table}`)
    return Number(rows[0]?.n ?? 0)
  }

  private async reclaim(c: PoolClient, table: 'series' | 'chapters', deleted: number, totalBefore: number, policy: StoragePolicy): Promise<string> {
    if (deleted <= 0) return 'tidak ada perubahan'
    const fraction = totalBefore > 0 ? deleted / totalBefore : 0
    const { rows } = await c.query<{ t: string; d: string }>(
      'SELECT pg_total_relation_size($1::regclass)::bigint AS t, pg_database_size(current_database())::bigint AS d',
      [table]
    )
    const size = Number(rows[0]?.t ?? 0)
    const used = Number(rows[0]?.d ?? 0)
    if (size >= FULL_REWRITE_MIN_BYTES && fraction >= FULL_REWRITE_MIN_FRACTION) {
      const live = size * Math.max(0.05, 1 - fraction)
      const headroom = this.limitBytes - used
      if (headroom >= live * 1.6 + 4_000_000) {
        try {
          await this.vacuum(c, table, true)
          return 'ruang dikembalikan (VACUUM FULL)'
        } catch {
          await this.vacuum(c, table, false)
          return 'ruang dipakai ulang (VACUUM)'
        }
      }
      if (policy.level === 'critical' && table === 'chapters') {
        await c.query('TRUNCATE chapters')
        await this.vacuum(c, 'chapters', false)
        return 'darurat: cache chapter dikosongkan (diisi ulang otomatis dari sumber)'
      }
    }
    await this.vacuum(c, table, false)
    return 'ruang dipakai ulang (VACUUM)'
  }

  private async vacuum(c: PoolClient, table: Table, full: boolean): Promise<void> {
    await c.query(full ? `VACUUM (FULL, ANALYZE) ${table}` : `VACUUM (ANALYZE) ${table}`)
  }
}

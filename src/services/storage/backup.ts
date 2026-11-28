import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable, pipeline as pipelineCb } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type { Pool, PoolClient } from 'pg'
import { AppError } from '../../core/errors.js'

export interface BackupConfig {
  dir: string
  keepDaily: number
  keepWeekly: number
}

export interface BackupInfo {
  name: string
  bytes: number
  createdAt: string
}

export interface BackupResult extends BackupInfo {
  counts: Record<string, number>
  removed: string[]
}

export interface RestoreResult {
  read: Record<string, number>
  inserted: Record<string, number>
}

interface KeyColumn {
  col: string
  type: string
}

interface TableSpec {
  name: string
  key: KeyColumn[]
  page: number
  serial?: string
  identity?: boolean
  optional?: boolean
}

export const BACKUP_TABLES: TableSpec[] = [
  { name: 'users', key: [{ col: 'id', type: 'integer' }], page: 20, serial: 'id' },
  { name: 'comments', key: [{ col: 'id', type: 'bigint' }], page: 1000, serial: 'id' },
  { name: 'comment_votes', key: [{ col: 'comment_id', type: 'bigint' }, { col: 'user_id', type: 'integer' }], page: 2000 },
  { name: 'xp_events', key: [{ col: 'id', type: 'bigint' }], page: 2000, serial: 'id' },
  { name: 'read_days', key: [{ col: 'user_id', type: 'integer' }, { col: 'day', type: 'date' }], page: 2000 },
  { name: 'reading_progress', key: [{ col: 'user_id', type: 'integer' }, { col: 'series_id', type: 'text' }], page: 500 },
  { name: 'user_library', key: [{ col: 'user_id', type: 'integer' }, { col: 'series_id', type: 'text' }], page: 200 },
  { name: 'announcements', key: [{ col: 'id', type: 'integer' }], page: 500, serial: 'id', identity: true },
  { name: 'push_settings', key: [{ col: 'id', type: 'smallint' }], page: 10 },
  { name: 'premium_orders', key: [{ col: 'id', type: 'text' }], page: 500, optional: true },
  { name: 'chapter_images', key: [{ col: 'provider', type: 'text' }, { col: 'ref', type: 'text' }], page: 200 }
]

const BACKUP_LOCK_ID = 727276
const WEEK_MS = 7 * 24 * 3_600_000
const NAME_RE = /^mitoon-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ndjson\.gz$/
const FORMAT = 'mitoon-backup'
const pad = (n: number) => String(n).padStart(2, '0')

export const isBackupName = (name: string) => NAME_RE.test(name)

export function parseBackupName(name: string): number | null {
  const m = NAME_RE.exec(name)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

export function backupName(date = new Date()): string {
  const d = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  const t = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  return `mitoon-${d}-${t}.ndjson.gz`
}

export function selectKeep(names: string[], keepDaily: number, keepWeekly: number): { keep: string[]; remove: string[] } {
  const dated = names
    .map(name => ({ name, at: parseBackupName(name) }))
    .filter((x): x is { name: string; at: number } => x.at !== null)
    .sort((a, b) => b.at - a.at)
  const keep = new Set(dated.slice(0, keepDaily).map(x => x.name))
  const weeks = new Set<number>()
  for (const x of dated.slice(keepDaily)) {
    const week = Math.floor(x.at / WEEK_MS)
    if (weeks.has(week)) continue
    if (weeks.size >= keepWeekly) break
    weeks.add(week)
    keep.add(x.name)
  }
  return { keep: dated.filter(x => keep.has(x.name)).map(x => x.name), remove: dated.filter(x => !keep.has(x.name)).map(x => x.name) }
}

const selectSql = (t: TableSpec, cursor: boolean) => {
  const cols = t.key.map(k => `t.${k.col}`).join(', ')
  const keys = t.key.map((k, i) => `t.${k.col}::text AS k${i}`).join(', ')
  const where = cursor ? `WHERE (${cols}) > (${t.key.map((k, i) => `$${i + 2}::${k.type}`).join(', ')})` : ''
  return `SELECT to_jsonb(t)::text AS j, ${keys} FROM ${t.name} t ${where} ORDER BY ${cols} LIMIT $1`
}

export class BackupService {
  constructor(
    private readonly pool: Pool,
    private readonly cfg: BackupConfig
  ) {}

  async list(): Promise<BackupInfo[]> {
    let names: string[]
    try {
      names = await readdir(this.cfg.dir)
    } catch {
      return []
    }
    const out: BackupInfo[] = []
    for (const name of names.filter(isBackupName)) {
      try {
        const s = await stat(join(this.cfg.dir, name))
        out.push({ name, bytes: s.size, createdAt: new Date(parseBackupName(name) as number).toISOString() })
      } catch {
        continue
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  pathOf(name: string): string {
    if (!isBackupName(name)) throw new AppError(400, 'BAD_REQUEST', 'Nama backup tidak valid')
    return join(this.cfg.dir, name)
  }

  openStream(name: string): Readable {
    return createReadStream(this.pathOf(name))
  }

  private async *lines(client: PoolClient, counts: Record<string, number>): AsyncGenerator<string> {
    const schema = await client.query<{ name: string | null }>('SELECT max(name) AS name FROM schema_migrations')
    yield `${JSON.stringify({ _: FORMAT, v: 1, createdAt: new Date().toISOString(), schema: schema.rows[0]?.name ?? null, tables: BACKUP_TABLES.map(t => t.name) })}\n`
    for (const table of BACKUP_TABLES) {
      counts[table.name] = 0
      if (table.optional && !(await this.exists(client, table.name))) continue
      let cursor: string[] | null = null
      for (;;) {
        const res: { rows: Array<Record<string, string>> } = cursor
          ? await client.query(selectSql(table, true), [table.page, ...cursor])
          : await client.query(selectSql(table, false), [table.page])
        for (const row of res.rows) {
          counts[table.name]++
          yield `{"t":${JSON.stringify(table.name)},"r":${row.j}}\n`
        }
        const last = res.rows[res.rows.length - 1]
        if (!last || res.rows.length < table.page) break
        cursor = table.key.map((_, i) => last[`k${i}`] as string)
      }
    }
    yield `${JSON.stringify({ _: 'end', counts })}\n`
  }

  private async exists(client: PoolClient, name: string): Promise<boolean> {
    const res = await client.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${name}`])
    return res.rows[0]?.ok === true
  }

  private async openSnapshot(): Promise<PoolClient> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout = '300s'")
      return client
    } catch (e) {
      client.release()
      throw e
    }
  }

  async create(): Promise<BackupResult> {
    await mkdir(this.cfg.dir, { recursive: true })
    const name = backupName()
    const final = join(this.cfg.dir, name)
    const tmp = `${final}.tmp`
    const client = await this.openSnapshot()
    let locked = false
    const counts: Record<string, number> = {}
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [BACKUP_LOCK_ID])
      if (lock.rows[0]?.ok !== true) throw new AppError(409, 'BACKUP_BUSY', 'Backup lain sedang berjalan')
      locked = true
      await pipeline(Readable.from(this.lines(client, counts)), createGzip({ level: 6 }), createWriteStream(tmp))
      await client.query('COMMIT')
      const verified = await this.verify(tmp)
      for (const table of BACKUP_TABLES) {
        if (verified[table.name] !== counts[table.name]) throw new Error(`Verifikasi backup gagal pada tabel ${table.name}`)
      }
      await rename(tmp, final)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      await rm(tmp, { force: true })
      throw e
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [BACKUP_LOCK_ID]).catch(() => undefined)
      client.release()
    }
    const removed = await this.rotate()
    const s = await stat(final)
    return { name, bytes: s.size, createdAt: new Date(parseBackupName(name) as number).toISOString(), counts, removed }
  }

  async rotate(): Promise<string[]> {
    const names = (await this.list()).map(b => b.name)
    const { remove } = selectKeep(names, this.cfg.keepDaily, this.cfg.keepWeekly)
    for (const name of remove) await rm(join(this.cfg.dir, name), { force: true })
    return remove
  }

  async verify(path: string): Promise<Record<string, number>> {
    const seen: Record<string, number> = {}
    let manifest = false
    let end: Record<string, number> | null = null
    const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      const head = line.slice(0, 40)
      if (head.startsWith('{"t":')) {
        const name = /^\{"t":"([a-z_]+)"/.exec(head)?.[1]
        if (!name) throw new Error('Baris backup tidak valid')
        seen[name] = (seen[name] ?? 0) + 1
        continue
      }
      const meta = JSON.parse(line) as { _?: string; counts?: Record<string, number> }
      if (meta._ === FORMAT) manifest = true
      else if (meta._ === 'end') end = meta.counts ?? {}
    }
    if (!manifest || !end) throw new Error('Backup tidak lengkap')
    for (const table of BACKUP_TABLES) {
      const expected = end[table.name] ?? 0
      if ((seen[table.name] ?? 0) !== expected) throw new Error(`Jumlah baris ${table.name} tidak cocok`)
      seen[table.name] = expected
    }
    return seen
  }

  async exportStream(): Promise<Readable> {
    const client = await this.openSnapshot()
    let released = false
    const release = async () => {
      if (released) return
      released = true
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const source = Readable.from(this.guarded(client, release))
    const gzip = createGzip({ level: 6 })
    pipelineCb(source, gzip, () => undefined)
    gzip.once('close', () => void release())
    return gzip
  }

  private async *guarded(client: PoolClient, release: () => Promise<void>): AsyncGenerator<string> {
    try {
      yield* this.lines(client, {})
    } finally {
      await release()
    }
  }

  async restore(path: string): Promise<RestoreResult> {
    const specs = new Map(BACKUP_TABLES.map(t => [t.name, t]))
    const read: Record<string, number> = {}
    const inserted: Record<string, number> = {}
    const buffers = new Map<string, string[]>()
    const client = await this.pool.connect()
    const flush = async (name: string) => {
      const rows = buffers.get(name)
      if (!rows?.length) return
      buffers.set(name, [])
      const spec = specs.get(name) as TableSpec
      if (spec.optional && !(await this.exists(client, name))) return
      const override = spec.identity ? 'OVERRIDING SYSTEM VALUE ' : ''
      const res = await client.query(
        `INSERT INTO ${name} ${override}SELECT * FROM jsonb_populate_recordset(NULL::${name}, $1::jsonb) ON CONFLICT DO NOTHING`,
        [`[${rows.join(',')}]`]
      )
      inserted[name] = (inserted[name] ?? 0) + (res.rowCount ?? 0)
    }
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '0'")
      const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })
      let schema: string | null = null
      let ended = false
      for await (const line of rl) {
        if (!line) continue
        if (line.startsWith('{"t":')) {
          const sep = line.indexOf(',"r":')
          const name = JSON.parse(`${line.slice(0, sep)}}`).t as string
          const spec = specs.get(name)
          if (!spec) throw new Error(`Tabel tidak dikenal di backup: ${name}`)
          const rows = buffers.get(name) ?? []
          rows.push(line.slice(sep + 5, -1))
          buffers.set(name, rows)
          read[name] = (read[name] ?? 0) + 1
          if (rows.length >= spec.page) await flush(name)
          continue
        }
        const meta = JSON.parse(line) as { _?: string; schema?: string | null }
        if (meta._ === FORMAT) {
          schema = meta.schema ?? null
          const current = await client.query<{ name: string | null }>('SELECT max(name) AS name FROM schema_migrations')
          const have = current.rows[0]?.name ?? null
          if (schema && have && schema > have) throw new Error(`Skema database (${have}) lebih lama dari backup (${schema}); jalankan migrasi dulu`)
        } else if (meta._ === 'end') ended = true
      }
      if (!schema && !ended) throw new Error('Berkas backup tidak valid')
      if (!ended) throw new Error('Berkas backup terpotong, restore dibatalkan')
      for (const spec of BACKUP_TABLES) await flush(spec.name)
      for (const spec of BACKUP_TABLES) {
        if (!spec.serial) continue
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${spec.name}', '${spec.serial}'), COALESCE((SELECT MAX(${spec.serial}) FROM ${spec.name}), 1), (SELECT MAX(${spec.serial}) FROM ${spec.name}) IS NOT NULL)`
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      client.release()
    }
    return { read, inserted }
  }
}

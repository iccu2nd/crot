import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import { AppError } from '../src/core/errors.js'
import {
  BACKUP_TABLES,
  BackupService,
  StorageCleaner,
  assertBlobAllowed,
  backupName,
  forecast,
  levelFor,
  nextLevel,
  parseBackupName,
  policyFor,
  selectKeep,
  STORAGE_LEVELS
} from '../src/services/storage/index.js'

type Row = Record<string, unknown>

class FakeClient {
  readonly sql: string[] = []
  readonly inserts: { name: string; rows: Row[] }[] = []
  released = 0

  constructor(
    private readonly tables: Record<string, Row[]> = {},
    private readonly scripted: (sql: string, params: unknown[]) => { rows: Row[]; rowCount?: number } | undefined = () => undefined
  ) {}

  async query(sql: string, params: unknown[] = []) {
    this.sql.push(sql)
    const custom = this.scripted(sql, params)
    if (custom) return { rowCount: custom.rows.length, ...custom }
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }], rowCount: 1 }
    if (/max\(name\)/.test(sql)) return { rows: [{ name: '038_storage_management.sql' }], rowCount: 1 }
    const select = /FROM (\w+) t\b/.exec(sql)
    if (select && /to_jsonb/.test(sql)) {
      const all = this.tables[select[1]] ?? []
      const limit = Number(params[0])
      const after = params.length > 1 ? Number(params[1]) : -Infinity
      const slice = all.filter(r => Number(r.id ?? r.user_id) > after).slice(0, limit)
      return { rows: slice.map(r => ({ j: JSON.stringify(r), k0: String(r.id ?? r.user_id), k1: '' })), rowCount: slice.length }
    }
    const insert = /^INSERT INTO (\w+) /.exec(sql)
    if (insert) {
      const rows = JSON.parse(String(params[0])) as Row[]
      this.inserts.push({ name: insert[1], rows })
      return { rows: [], rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }

  release() {
    this.released++
  }
}

const poolOf = (client: FakeClient) => ({ connect: async () => client, query: client.query.bind(client) }) as unknown as Pool

describe('storage policy', () => {
  it('levelFor memetakan ambang batas', () => {
    assert.equal(levelFor(0.1), 'ok')
    assert.equal(levelFor(0.7), 'notice')
    assert.equal(levelFor(0.8), 'warning')
    assert.equal(levelFor(0.9), 'high')
    assert.equal(levelFor(0.95), 'critical')
    assert.equal(levelFor(1.4), 'critical')
  })

  it('nextLevel naik segera dan turun dengan histeresis', () => {
    assert.equal(nextLevel('ok', 0.82), 'warning')
    assert.equal(nextLevel('critical', 0.94), 'critical')
    assert.equal(nextLevel('critical', 0.92), 'high')
    assert.equal(nextLevel('warning', 0.79), 'warning')
    assert.equal(nextLevel('warning', 0.77), 'notice')
    assert.equal(nextLevel('high', 0.3), 'ok')
  })

  it('kebijakan makin ketat seiring level', () => {
    const list = STORAGE_LEVELS.map(policyFor)
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].blobScale <= list[i - 1].blobScale)
      assert.ok(list[i].enrichScale <= list[i - 1].enrichScale)
      assert.ok(list[i].coldChapterDays <= list[i - 1].coldChapterDays)
      assert.ok(list[i].viewRetentionDays <= list[i - 1].viewRetentionDays)
      assert.ok(list[i].xpLedgerDays <= list[i - 1].xpLedgerDays)
    }
    assert.equal(policyFor('ok').crawl, 'full')
    assert.equal(policyFor('warning').crawl, 'light')
    assert.equal(policyFor('high').crawl, 'off')
    assert.equal(policyFor('critical').catalogWrites, false)
    assert.equal(policyFor('critical').chapterWrites, 'none')
    assert.equal(policyFor('ok').staleSeriesDays, null)
  })

  it('assertBlobAllowed membatasi unggahan sesuai level', async () => {
    const guard = (level: (typeof STORAGE_LEVELS)[number]) => ({ policy: async () => policyFor(level) })
    await assertBlobAllowed(undefined, 10_000_000, 1)
    await assertBlobAllowed(guard('ok'), 300_000, 300_000)
    await assertBlobAllowed(guard('warning'), 140_000, 300_000)
    await assert.rejects(() => assertBlobAllowed(guard('warning'), 200_000, 300_000), (e: unknown) => e instanceof AppError && e.code === 'STORAGE_LOW' && e.status === 507)
    await assert.rejects(() => assertBlobAllowed(guard('critical'), 1, 300_000), (e: unknown) => e instanceof AppError && e.code === 'STORAGE_FULL')
  })

  it('forecast memperkirakan waktu menuju level kritis', () => {
    const hour = 3_600_000
    const limit = 200_000_000
    const f = forecast([{ at: 0, bytes: 100_000_000 }, { at: 10 * hour, bytes: 120_000_000 }], limit, 0.95)
    assert.equal(Math.round(f.bytesPerHour), 2_000_000)
    assert.equal(Math.round(f.hoursToCritical as number), 35)
    assert.equal(forecast([{ at: 0, bytes: 5 }], limit, 0.95).hoursToCritical, null)
    assert.equal(forecast([{ at: 0, bytes: 9 }, { at: 5 * hour, bytes: 5 }], limit, 0.95).hoursToCritical, null)
    assert.equal(forecast([{ at: 0, bytes: 189_000_000 }, { at: hour, bytes: 191_000_000 }], limit, 0.95).hoursToCritical, 0)
  })
})

describe('rotasi backup', () => {
  it('nama backup bisa dibaca kembali', () => {
    const d = new Date(Date.UTC(2026, 10, 27, 3, 4, 5))
    assert.equal(backupName(d), 'koyami-20261127-030405.ndjson.gz')
    assert.equal(parseBackupName(backupName(d)), d.getTime())
    assert.equal(parseBackupName('../etc/passwd'), null)
  })

  it('menyimpan harian terbaru dan satu per minggu, mengabaikan berkas asing', () => {
    const day = 86_400_000
    const base = Date.UTC(2026, 10, 27, 3, 0, 0)
    const names = Array.from({ length: 40 }, (_, i) => backupName(new Date(base - i * day)))
    const { keep, remove } = selectKeep([...names, 'catatan.txt'], 7, 4)
    assert.equal(keep.length, 11)
    assert.deepEqual(keep.slice(0, 7), names.slice(0, 7))
    assert.equal(keep.length + remove.length, 40)
    assert.ok(!remove.includes('catatan.txt'))
    assert.ok(keep.every(k => !remove.includes(k)))
  })
})

describe('BackupService', () => {
  const users = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, username: `u${i + 1}` }))
  const library = [{ user_id: 1, series_id: 'lumos:a' }]

  it('membuat backup terverifikasi lalu memulihkannya ke database kosong', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koyami-bk-'))
    try {
      const source = new FakeClient({ users, user_library: library })
      const svc = new BackupService(poolOf(source), { dir, keepDaily: 3, keepWeekly: 1 })
      const result = await svc.create()
      assert.equal(result.counts.users, 45)
      assert.equal(result.counts.user_library, 1)
      assert.equal(result.counts.comments, 0)
      assert.deepEqual(await readdir(dir), [result.name])
      assert.ok(source.sql.includes('COMMIT'))
      assert.equal(source.released, 1)
      assert.ok(source.sql.some(s => /pg_advisory_unlock/.test(s)))

      const target = new FakeClient()
      const restored = await new BackupService(poolOf(target), { dir, keepDaily: 3, keepWeekly: 1 }).restore(join(dir, result.name))
      assert.equal(restored.read.users, 45)
      assert.equal(restored.inserted.users, 45)
      assert.equal(restored.inserted.user_library, 1)
      const order = target.inserts.map(i => i.name)
      assert.ok(order.indexOf('users') < order.indexOf('user_library'))
      assert.ok(target.sql.includes('COMMIT'))
      assert.ok(target.sql.some(s => /setval/.test(s)))
      assert.deepEqual(target.inserts.filter(i => i.name === 'users').flatMap(i => i.rows), users)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('membatalkan restore bila berkas terpotong', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koyami-bk-'))
    try {
      const svc = new BackupService(poolOf(new FakeClient({ users })), { dir, keepDaily: 3, keepWeekly: 1 })
      const { name } = await svc.create()
      const { createGzip } = await import('node:zlib')
      const { createWriteStream } = await import('node:fs')
      const broken = join(dir, 'broken.ndjson.gz')
      const gz = createGzip()
      gz.pipe(createWriteStream(broken))
      gz.end('{"_":"mitoon-backup","v":1,"schema":"001_init.sql"}\n{"t":"users","r":{"id":1}}\n')
      await new Promise(r => gz.once('end', r))
      await new Promise(r => setTimeout(r, 50))
      const target = new FakeClient()
      await assert.rejects(() => new BackupService(poolOf(target), { dir, keepDaily: 3, keepWeekly: 1 }).restore(broken), /terpotong/)
      assert.ok(target.sql.includes('ROLLBACK'))
      assert.ok(name.endsWith('.ndjson.gz'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('menolak nama berkas yang berbahaya', () => {
    const svc = new BackupService(poolOf(new FakeClient()), { dir: '/tmp/x', keepDaily: 1, keepWeekly: 1 })
    assert.throws(() => svc.pathOf('../../etc/passwd'))
    assert.ok(BACKUP_TABLES.some(t => t.name === 'user_library'))
  })
})

describe('StorageCleaner', () => {
  const protectedTables = ['users', 'user_library', 'reading_progress', 'read_days', 'comments', 'comment_votes', 'chat_messages', 'chapter_images']
  const mutation = new RegExp(`\\b(DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?|UPDATE|INSERT\\s+INTO|VACUUM[^;]*?)\\s+(${protectedTables.join('|')})\\b`, 'i')

  it('tidak pernah mengubah data penting pengguna di level mana pun', async () => {
    for (const level of STORAGE_LEVELS) {
      const client = new FakeClient({}, sql => {
        if (/SELECT s\.id FROM series s/.test(sql)) return { rows: [{ id: '1' }, { id: '2' }] }
        if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ n: '100' }] }
        if (/pg_total_relation_size/.test(sql)) return { rows: [{ t: '90000000', d: '150000000' }] }
        return undefined
      })
      const report = await new StorageCleaner(poolOf(client), 200_000_000).run(policyFor(level))
      assert.equal(report.locked, false)
      assert.ok(report.steps.every(s => !s.error), JSON.stringify(report.steps))
      for (const sql of client.sql) assert.ok(!mutation.test(sql), `${level}: ${sql}`)
      assert.ok(client.sql.some(s => /DELETE FROM chapters/.test(s)))
      assert.equal(client.released, 1)
    }
  })

  it('memangkas buku besar XP lama tanpa menyentuh total XP pengguna', async () => {
    const client = new FakeClient()
    const params: unknown[][] = []
    const spy = client.query.bind(client)
    client.query = async (sql: string, p: unknown[] = []) => {
      if (/DELETE FROM xp_events/.test(sql)) params.push(p)
      return spy(sql, p)
    }
    await new StorageCleaner(poolOf(client), 200_000_000).run(policyFor('warning'))
    assert.deepEqual(params, [[45]])
    assert.ok(client.sql.every(s => !/UPDATE users/.test(s)))
  })

  it('melewati seri usang pada level aman dan menghapusnya saat tertekan', async () => {
    const run = async (level: (typeof STORAGE_LEVELS)[number]) => {
      const client = new FakeClient({}, sql => (/last_seen_at < now\(\)/.test(sql) && /SELECT s\.id/.test(sql) ? { rows: [{ id: '9' }] } : undefined))
      await new StorageCleaner(poolOf(client), 200_000_000).run(policyFor(level))
      return client.sql.some(s => /DELETE FROM series WHERE/.test(s))
    }
    assert.equal(await run('ok'), false)
    assert.equal(await run('high'), true)
  })

  it('memakai VACUUM FULL hanya bila ada ruang, dan mengosongkan cache chapter saat kritis tanpa ruang', async () => {
    const script = (used: string) => (sql: string) => {
      if (/SELECT s\.id FROM series s/.test(sql) && /FROM chapters c/.test(sql)) return { rows: [{ id: '1' }] }
      if (/count\(\*\)::bigint/.test(sql)) return { rows: [{ n: '1000' }] }
      if (/DELETE FROM chapters/.test(sql)) return { rows: [], rowCount: 600 }
      if (/pg_total_relation_size/.test(sql)) return { rows: [{ t: '50000000', d: used }] }
      return undefined
    }
    const roomy = new FakeClient({}, script('100000000'))
    await new StorageCleaner(poolOf(roomy), 200_000_000).run(policyFor('high'))
    assert.ok(roomy.sql.some(s => /VACUUM \(FULL, ANALYZE\) chapters/.test(s)))

    const tight = new FakeClient({}, script('195000000'))
    await new StorageCleaner(poolOf(tight), 200_000_000).run(policyFor('high'))
    assert.ok(!tight.sql.some(s => /FULL|TRUNCATE/.test(s)))

    const emergency = new FakeClient({}, script('195000000'))
    await new StorageCleaner(poolOf(emergency), 200_000_000).run(policyFor('critical'))
    assert.ok(emergency.sql.some(s => /TRUNCATE chapters/.test(s)))
  })

  it('tidak berjalan bila pembersihan lain memegang kunci', async () => {
    const client = new FakeClient({}, sql => (/pg_try_advisory_lock/.test(sql) ? { rows: [{ ok: false }] } : undefined))
    const report = await new StorageCleaner(poolOf(client), 200_000_000).run(policyFor('high'))
    assert.equal(report.locked, true)
    assert.equal(report.steps.length, 0)
    assert.equal(client.released, 1)
  })
})

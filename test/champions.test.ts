import test from 'node:test'
import assert from 'node:assert/strict'
import { WeeklyChampions } from '../src/services/champions.js'

const log = { warn() {}, info() {}, error() {} } as any
// Senin 2026-11-30 03:00 WIB -> minggu yang baru selesai: Senin 2026-11-23
const NOW = Date.parse('2026-11-30T03:00:00+07:00')

function fakePool(pending: any[] = []) {
  const calls: { sql: string; p: any[] }[] = []
  return {
    calls,
    query: async (sql: string, p: any[] = []) => {
      calls.push({ sql, p })
      if (/INSERT INTO weekly_winners/.test(sql)) return { rowCount: 3, rows: [] }
      if (/FROM weekly_winners\s+WHERE notified_at IS NULL/.test(sql)) return { rows: pending }
      return { rows: [], rowCount: 0 }
    }
  }
}

test('finalize: membekukan minggu lalu sekali saja, lalu mengirim push ke tiap juara', async () => {
  const pending = [
    { week_start: '2026-11-23', rank: 1, user_id: 7, week_xp: 900 },
    { week_start: '2026-11-23', rank: 2, user_id: 3, week_xp: 500 }
  ]
  const pool = fakePool(pending)
  const sent: any[] = []
  const push = { configured: true, champion: async (...a: any[]) => (sent.push(a), true) }
  const svc = new WeeklyChampions(pool as any, log, push)

  const r1 = await svc.finalize(NOW)
  assert.equal(r1.weekStart, '2026-11-23')
  assert.equal(r1.inserted, 3)
  assert.equal(r1.notified, 2)
  const ins = pool.calls.find(c => /INSERT INTO weekly_winners/.test(c.sql))!
  assert.deepEqual(ins.p, ['2026-11-23', '2026-11-30']) // [Senin lalu, Senin ini)
  assert.deepEqual(sent, [[7, 1, 900], [3, 2, 500]])
  assert.equal(pool.calls.filter(c => /UPDATE weekly_winners SET notified_at/.test(c.sql)).length, 2)

  const r2 = await svc.finalize(NOW + 60_000) // putaran berikutnya: minggu yang sama tidak dibekukan ulang
  assert.equal(r2.inserted, 0)
  assert.equal(pool.calls.filter(c => /INSERT INTO weekly_winners/.test(c.sql)).length, 1)
})

test('finalize: push mati/gagal -> notified_at tidak ditandai (dicoba lagi nanti), tanpa push -> tidak menyentuh antrean', async () => {
  const pending = [{ week_start: '2026-11-23', rank: 1, user_id: 7, week_xp: 900 }]
  const pool = fakePool(pending)
  const off = new WeeklyChampions(pool as any, log, { configured: true, champion: async () => false })
  assert.equal((await off.finalize(NOW)).notified, 0)
  const boom = new WeeklyChampions(pool as any, log, { configured: true, champion: async () => { throw new Error('fcm down') } })
  assert.equal((await boom.finalize(NOW)).notified, 0)
  assert.equal(pool.calls.filter(c => /UPDATE weekly_winners/.test(c.sql)).length, 0)

  const none = fakePool(pending)
  await new WeeklyChampions(none as any, log).finalize(NOW)
  assert.equal(none.calls.some(c => /notified_at IS NULL/.test(c.sql)), false)
})

test('history: hitungan per peringkat + juara terbaru dengan weekStart = Senin 00.00 WIB', async () => {
  const pool = {
    query: async (sql: string) =>
      /GROUP BY rank/.test(sql)
        ? { rows: [{ rank: 1, n: 2 }, { rank: 3, n: 1 }] }
        : { rows: [{ ws: '2026-11-23', rank: 1, week_xp: 900 }, { ws: '2026-11-16', rank: 3, week_xp: 400 }] }
  }
  const h = await new WeeklyChampions(pool as any, log).history(7)
  assert.deepEqual([h.first, h.second, h.third], [2, 0, 1])
  assert.equal(h.recent[0].weekStart, Date.parse('2026-11-22T17:00:00Z'))
  assert.deepEqual(h.recent.map(r => r.rank), [1, 3])
})

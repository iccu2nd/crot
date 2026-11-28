import test from 'node:test'
import assert from 'node:assert/strict'
import { XpService, withTopRank } from '../src/services/xp.js'

type Row = { user: { id: number; topRank?: number } }

test('topThree: id -> peringkat 1-3, di-cache, dan withTopRank menandai penulisnya', async () => {
  let calls = 0
  const pool = { query: async () => (calls++, { rows: [{ user_id: 7, rank: 1 }, { user_id: 3, rank: 2 }, { user_id: 9, rank: 3 }] }) }
  const xp = new XpService(pool as any)
  assert.deepEqual([...(await xp.topThree())], [[7, 1], [3, 2], [9, 3]])
  await xp.topThree()
  assert.equal(calls, 1) // cache 30 dtk
  const items: Row[] = [{ user: { id: 3 } }, { user: { id: 4 } }]
  await withTopRank(xp, items)
  assert.equal(items[0].user.topRank, 2)
  assert.equal('topRank' in items[1].user, false) // bukan juara: tanpa field
})

test('withTopRank: query gagal atau tanpa xp = daftar apa adanya', async () => {
  const xp = new XpService({ query: async () => { throw new Error('db down') } } as any)
  const items: Row[] = [{ user: { id: 1 } }]
  assert.equal((await withTopRank(xp, items))[0].user.topRank, undefined)
  assert.equal((await withTopRank(undefined, items))[0].user.topRank, undefined)
  assert.equal((await withTopRank({ award: async () => 1 } as any, items))[0].user.topRank, undefined) // stub tanpa topThree
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkTarget, cleanComment, isJpeg } from '../src/core/comments.js'
import { CommentService } from '../src/services/comments.js'

test('target komentar: seri & chapter valid, lainnya ditolak', () => {
  assert.equal(checkTarget('s:lumos:abc-123'), 's:lumos:abc-123')
  assert.equal(checkTarget('c:manta:12:345'), 'c:manta:12:345')
  for (const bad of ['', 'x:lumos:a', 's:lumos', 's:lumos:a b', 's:lumos:' + 'a'.repeat(400), undefined, 5]) assert.throws(() => checkTarget(bad), /tidak valid/)
})

test('isi komentar: dirapikan, kosong/terlalu panjang ditolak', () => {
  assert.equal(cleanComment('  halo\u0000 dunia\r\n\r\n\r\n\r\nlagi  '), 'halo dunia\n\nlagi')
  assert.throws(() => cleanComment('   '), /kosong/)
  assert.throws(() => cleanComment('x'.repeat(1001)), /terlalu panjang/)
  assert.equal(cleanComment('x'.repeat(1000)).length, 1000)
})

test('isJpeg memeriksa magic bytes', () => {
  assert.ok(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])))
  assert.ok(!isJpeg(Buffer.from('<html>')))
  assert.ok(!isJpeg('bukan buffer'))
})

function fakePool() {
  const rows: any[] = []
  const users: Record<number, { username: string }> = { 1: { username: 'budi' }, 2: { username: 'andi' } }
  let seq = 0
  const join = (c: any) => ({ id: c.id, body: c.body, created_at: c.created_at, uid: c.user_id, username: users[c.user_id].username, avatar_v: 0 })
  return {
    rows,
    async query(sql: string, p: any[] = []) {
      if (sql.startsWith('INSERT INTO comments')) {
        const c = { id: ++seq, target: p[0], user_id: p[1], body: p[2], created_at: new Date(1_700_000_000_000 + seq) }
        rows.push(c)
        return { rows: [{ id: c.id }] }
      }
      if (sql.includes('WHERE c.id = $1')) return { rows: rows.filter(c => c.id === p[0]).map(join) }
      if (sql.includes('WHERE c.target = $1 AND')) {
        const out = rows.filter(c => c.target === p[0] && (p[1] == null || c.id < p[1])).sort((a, b) => b.id - a.id).slice(0, p[2])
        return { rows: out.map(join) }
      }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: rows.filter(c => c.target === p[0]).length }] }
      if (sql.startsWith('DELETE FROM comments')) {
        const i = rows.findIndex(c => c.id === p[0] && c.user_id === p[1])
        if (i >= 0) rows.splice(i, 1)
        return { rowCount: i >= 0 ? 1 : 0, rows: [] }
      }
      throw new Error(`sql tak dikenal: ${sql}`)
    }
  }
}

test('komentar: tambah, daftar terbaru dulu + paginasi, hapus hanya milik sendiri', async () => {
  const svc = new CommentService(fakePool() as any)
  const t = 's:lumos:seri-1'
  const a = await svc.add(1, t, 'pertama')
  await svc.add(2, t, 'kedua')
  await svc.add(1, t, 'ketiga')
  await svc.add(1, 'c:lumos:bab-9', 'beda target')
  assert.equal(a.user.username, 'budi')

  const page1 = await svc.list(t, 2)
  assert.equal(page1.total, 3)
  assert.deepEqual(page1.items.map(i => i.body), ['ketiga', 'kedua'])
  const page2 = await svc.list(t, 2, page1.items.at(-1)!.id)
  assert.deepEqual(page2.items.map(i => i.body), ['pertama'])

  await assert.rejects(svc.remove(2, a.id), /tidak ditemukan/) // bukan penulisnya
  await svc.remove(1, a.id)
  assert.equal((await svc.list(t)).total, 2)
  await assert.rejects(svc.add(1, 'ngawur', 'x'), /tidak valid/)
})

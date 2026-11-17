import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkTarget, cleanComment, isJpeg } from '../src/core/comments.js'
import { CommentService } from '../src/services/comments.js'
import { XP_RULES, levelCost, levelFor } from '../src/core/xp.js'
import { XpService } from '../src/services/xp.js'

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
  const votes: { comment_id: number; user_id: number; value: number }[] = []
  const users: Record<number, { username: string; display_name?: string; xp?: number }> = { 1: { username: 'budi', xp: 100 }, 2: { username: 'andi', display_name: 'Andi S' } }
  let seq = 0
  const join = (c: any, viewer: number | null = null) => ({
    id: c.id, body: c.body, created_at: c.created_at, parent_id: c.parent_id ?? null, uid: c.user_id,
    username: users[c.user_id].username, display_name: users[c.user_id].display_name, xp: users[c.user_id].xp ?? 0, avatar_v: 0,
    reply_to_name: c.reply_to_user_id ? (users[c.reply_to_user_id].display_name || users[c.reply_to_user_id].username) : null,
    likes: votes.filter(v => v.comment_id === c.id && v.value === 1).length,
    dislikes: votes.filter(v => v.comment_id === c.id && v.value === -1).length,
    my_vote: votes.find(v => v.comment_id === c.id && v.user_id === viewer)?.value ?? 0,
    reply_count: rows.filter(r => r.parent_id === c.id).length
  })
  return {
    rows, votes,
    async query(sql: string, p: any[] = []) {
      if (sql.startsWith('INSERT INTO comments')) {
        const c = { id: ++seq, target: p[0], user_id: p[1], body: p[2], parent_id: p[3], reply_to_user_id: p[4], created_at: new Date(1_700_000_000_000 + seq) }
        rows.push(c)
        return { rows: [{ id: c.id }] }
      }
      if (sql.startsWith('SELECT id, target, parent_id, user_id FROM comments')) return { rows: rows.filter(c => c.id === p[0]) }
      if (sql.startsWith('SELECT user_id FROM comments')) return { rows: rows.filter(c => c.id === p[0]) }
      if (sql.includes('WHERE c.user_id = $1')) {
        const out = rows.filter(c => c.user_id === p[0] && (p[1] == null || c.id < p[1])).sort((a, b) => b.id - a.id).slice(0, p[2])
        return { rows: out.map(c => ({ ...join(c, p[3]), target: c.target })) }
      }
      if (sql.includes('WHERE c.id = $1')) return { rows: rows.filter(c => c.id === p[0]).map(c => join(c, p[1])) }
      if (sql.includes('WHERE c.target = $1 AND')) {
        const out = rows.filter(c => c.target === p[0] && c.parent_id == null && (p[1] == null || c.id < p[1])).sort((a, b) => b.id - a.id).slice(0, p[2])
        return { rows: out.map(c => join(c, p[3])) }
      }
      if (sql.includes('WHERE c.parent_id = $1')) {
        const out = rows.filter(c => c.parent_id === p[0] && c.id > p[1]).sort((a, b) => a.id - b.id).slice(0, p[2])
        return { rows: out.map(c => join(c, p[3])) }
      }
      if (sql.startsWith('SELECT count(*)::int AS n FROM comments WHERE parent_id')) return { rows: [{ n: rows.filter(c => c.parent_id === p[0]).length }] }
      if (sql.startsWith('SELECT count(*)::int AS n FROM comments WHERE user_id')) return { rows: [{ n: rows.filter(c => c.user_id === p[0]).length }] }
      if (sql.startsWith('SELECT count(*)::int AS n FROM comments WHERE target')) return { rows: [{ n: rows.filter(c => c.target === p[0]).length }] }
      if (sql.startsWith('DELETE FROM comment_votes')) {
        const i = votes.findIndex(v => v.comment_id === p[0] && v.user_id === p[1])
        if (i >= 0) votes.splice(i, 1)
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO comment_votes')) {
        const v = votes.find(x => x.comment_id === p[0] && x.user_id === p[1])
        if (v) v.value = p[2]
        else votes.push({ comment_id: p[0], user_id: p[1], value: p[2] })
        return { rows: [] }
      }
      if (sql.startsWith('SELECT count(*) FILTER')) {
        const vs = votes.filter(v => v.comment_id === p[0])
        return { rows: [{ likes: vs.filter(v => v.value === 1).length, dislikes: vs.filter(v => v.value === -1).length }] }
      }
      if (sql.startsWith('DELETE FROM comments')) {
        const i = rows.findIndex(c => c.id === p[0] && c.user_id === p[1])
        if (i >= 0) {
          const id = rows[i].id
          rows.splice(i, 1)
          for (let j = rows.length - 1; j >= 0; j--) if (rows[j].parent_id === id) rows.splice(j, 1) // ON DELETE CASCADE
        }
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
  assert.equal(a.user.level, levelFor(100).level)

  const page1 = await svc.list(t, 2)
  assert.equal(page1.total, 3)
  assert.equal(page1.hasMore, true)
  assert.deepEqual(page1.items.map(i => i.body), ['ketiga', 'kedua'])
  const page2 = await svc.list(t, 2, page1.items.at(-1)!.id)
  assert.equal(page2.hasMore, false)
  assert.deepEqual(page2.items.map(i => i.body), ['pertama'])

  await assert.rejects(svc.remove(2, a.id), /tidak ditemukan/) // bukan penulisnya
  await svc.remove(1, a.id)
})

test('balasan: menempel ke komentar teratas, "membalas" hanya untuk balasan, daftar teratas tak memuat balasan', async () => {
  const svc = new CommentService(fakePool() as any)
  const t = 's:lumos:seri-1'
  const top = await svc.add(1, t, 'komentar')
  const r1 = await svc.add(2, t, 'balasan langsung', top.id)
  assert.equal(r1.parentId, top.id)
  assert.equal(r1.replyTo, '') // membalas komentar teratas: tanpa label
  const r2 = await svc.add(1, t, 'balas si andi', r1.id)
  assert.equal(r2.parentId, top.id) // tetap 1 tingkat
  assert.equal(r2.replyTo, 'Andi S')

  await assert.rejects(svc.add(1, 's:lumos:lain', 'x', top.id), /halaman yang sama/)
  await assert.rejects(svc.add(1, t, 'x', 999), /tidak ditemukan/)

  const list = await svc.list(t, 20)
  assert.equal(list.total, 3)
  assert.deepEqual(list.items.map(i => [i.body, i.replyCount]), [['komentar', 2]])
  const rep = await svc.replies(top.id, 1)
  assert.deepEqual(rep.items.map(i => i.body), ['balasan langsung'])
  assert.equal(rep.hasMore, true)
  const rep2 = await svc.replies(top.id, 1, rep.items[0].id)
  assert.deepEqual(rep2.items.map(i => i.body), ['balas si andi'])
  assert.equal(rep2.hasMore, false)
})

test('riwayat komentar: hanya milik sendiri (termasuk balasan), terbaru dulu, memuat target, paginasi', async () => {
  const svc = new CommentService(fakePool() as any)
  const top = await svc.add(2, 's:lumos:seri-1', 'milik andi')
  await svc.add(1, 's:lumos:seri-1', 'satu')
  await svc.add(1, 'c:lumos:bab-9', 'dua')
  await svc.add(1, 's:lumos:seri-1', 'balasan tiga', top.id)

  const p1 = await svc.mine(1, 2)
  assert.equal(p1.total, 3)
  assert.equal(p1.hasMore, true)
  assert.deepEqual(p1.items.map(i => [i.body, i.target, i.parentId === null]), [['balasan tiga', 's:lumos:seri-1', false], ['dua', 'c:lumos:bab-9', true]])
  const p2 = await svc.mine(1, 2, p1.items.at(-1)!.id)
  assert.equal(p2.hasMore, false)
  assert.deepEqual(p2.items.map(i => i.body), ['satu'])
  assert.deepEqual((await svc.mine(99)).items, [])
  // profil orang lain: myVote mengikuti pemirsa, bukan pemilik komentar
  await svc.vote(2, p1.items[0].id, 1)
  assert.equal((await svc.mine(1, 1, undefined, 2)).items[0].myVote, 1)
  assert.equal((await svc.mine(1, 1, undefined, null)).items[0].myVote, 0)
})

test('like/dislike: satu suara per pengguna, bisa ganti & batal, myVote sesuai pemirsa', async () => {
  const pool = fakePool()
  const svc = new CommentService(pool as any)
  const c = await svc.add(1, 's:lumos:seri-1', 'halo')
  assert.deepEqual(await svc.vote(2, c.id, 1), { likes: 1, dislikes: 0, myVote: 1 })
  assert.deepEqual(await svc.vote(2, c.id, 1), { likes: 1, dislikes: 0, myVote: 1 }) // tidak ganda
  assert.deepEqual(await svc.vote(1, c.id, -1), { likes: 1, dislikes: 1, myVote: -1 })
  assert.deepEqual(await svc.vote(2, c.id, -1), { likes: 0, dislikes: 2, myVote: -1 }) // ganti suara
  assert.deepEqual(await svc.vote(2, c.id, 0), { likes: 0, dislikes: 1, myVote: 0 }) // batal
  await svc.vote(2, c.id, 1)
  const asAndi = (await svc.list('s:lumos:seri-1', 20, undefined, 2)).items[0]
  const asAnon = (await svc.list('s:lumos:seri-1', 20)).items[0]
  assert.deepEqual([asAndi.likes, asAndi.dislikes, asAndi.myVote], [1, 1, 1])
  assert.equal(asAnon.myVote, 0)
  await assert.rejects(svc.vote(2, c.id, 5), /Suara/)
  await assert.rejects(svc.vote(2, 999, 1), /tidak ditemukan/)
})

test('XP dari like: hanya untuk like orang lain, sekali per penyuka', async () => {
  const awards: any[] = []
  const xp = { award: async (...a: any[]) => (awards.push(a), 1) } as any
  const svc = new CommentService(fakePool() as any, xp)
  const c = await svc.add(1, 's:lumos:seri-1', 'halo') // komentar -> XP komentar untuk penulis
  await svc.vote(2, c.id, 1)
  await svc.vote(1, c.id, 1) // like komentar sendiri: tanpa XP
  await svc.vote(2, c.id, -1) // dislike: tanpa XP
  assert.deepEqual(awards, [[1, 'comment', String(c.id)], [1, 'liked', `${c.id}:2`]])
})

test('kurva level: awal murah, makin tinggi makin mahal, konsisten dengan levelFor', () => {
  assert.equal(levelCost(1), 40)
  for (let l = 1; l < 200; l++) assert.ok(levelCost(l + 1) > levelCost(l))
  assert.deepEqual(levelFor(0), { level: 1, into: 0, need: 40 })
  assert.deepEqual(levelFor(39), { level: 1, into: 39, need: 40 })
  assert.deepEqual(levelFor(40), { level: 2, into: 0, need: levelCost(2) })
  let total = 0
  for (let l = 1; l < 10; l++) total += levelCost(l)
  assert.equal(levelFor(total).level, 10)
  assert.equal(levelFor(total - 1).level, 9)
  assert.equal(levelFor(-5).level, 1)
  // aktivitas ringan sudah cukup untuk naik cepat di awal: 4 chapter = level 2
  assert.equal(levelFor(4 * XP_RULES.read.xp).level, 2)
})

test('XpService: ledger (sekali per ref + batas harian) dan validasi laporan dari app', async () => {
  const calls: any[] = []
  let granted = true
  const svc = new XpService({ query: async (_sql: string, p: any[]) => (calls.push(p), { rows: granted ? [{ id: p[0] }] : [] }) } as any)
  assert.equal(await svc.report(7, 'read', 'lumos:bab-1'), XP_RULES.read.xp)
  assert.deepEqual(calls[0].slice(0, 3), [7, 'read', 'lumos:bab-1'])
  assert.deepEqual(calls[0].slice(3), [XP_RULES.read.xp, XP_RULES.read.perDay])
  granted = false
  assert.equal(await svc.report(7, 'read', 'lumos:bab-1'), 0) // sudah pernah / kuota habis
  granted = true
  await svc.report(7, 'daily', undefined)
  assert.match(calls.at(-1)[2], /^\d{4}-\d{2}-\d{2}$/) // ref = tanggal WIB
  await assert.rejects(svc.report(7, 'comment', 'x:y'), /tidak valid/) // jenis server-only ditolak
  await assert.rejects(svc.report(7, 'read', 'tanpa titik dua'), /Referensi/)
  await assert.rejects(svc.report(7, 'bookmark', undefined), /Referensi/)
})

test('top komentar: komentar owner disematkan di halaman pertama saja, tidak diulang di halaman berikutnya', async () => {
  const row = (id: number, email: string | null) => ({ id, body: `k${id}`, created_at: new Date(1_700_000_000_000 + id), parent_id: null, uid: id, username: `u${id}`, email, xp: 0, avatar_v: 0 })
  const calls: { sql: string; p: any[] }[] = []
  const pool = {
    async query(sql: string, p: any[] = []) {
      calls.push({ sql, p })
      if (sql.includes('ANY($2::text[])')) return { rows: [row(5, 'owner@x.id')] }
      if (sql.includes('NOT (c.id = ANY($5::bigint[]))')) return { rows: [row(9, null), row(7, null)] }
      return { rows: [{ n: 3 }] }
    }
  }
  const svc = new CommentService(pool as any, undefined, ['owner@x.id'])
  const first = await svc.list('s:lumos:seri-1', 20)
  assert.deepEqual(first.items.map(i => [i.id, i.pinned ?? false, i.user.isOwner]), [[5, true, true], [9, false, false], [7, false, false]])
  assert.deepEqual(calls.find(c => c.sql.includes('NOT (c.id'))!.p.at(-1), [5])
  const next = await svc.list('s:lumos:seri-1', 20, 7)
  assert.deepEqual(next.items.map(i => i.id), [9, 7]) // tanpa sematan di halaman lanjutan
})

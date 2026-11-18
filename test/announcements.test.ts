import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import { tokenMatches } from '../src/routes/announcements.js'
import { AnnouncementRepo } from '../src/services/announcements.js'

function fakePool(reply: { rows?: Record<string, unknown>[]; rowCount?: number | null } = {}) {
  const calls: { sql: string; params: unknown[] }[] = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? null }
    }
  } as unknown as Pool
  return { pool, calls }
}

const NO_POPUP = { popup: false, imageUrl: null, version: null, buttonText: null, cancelText: null }

describe('AnnouncementRepo', () => {
  it('active: memakai limit, memetakan baris (id numerik, body null -> kosong)', async () => {
    const { pool, calls } = fakePool({ rows: [{ id: '7', title: 'Halo', body: null, url: null, created_at: '2026-01-01T00:00:00Z' }, { id: 3, title: 'Update', body: 'v1.1', url: 'https://x.id' }] })
    const out = await new AnnouncementRepo(pool).active(2)
    assert.deepEqual(out, [
      { id: 7, title: 'Halo', body: '', url: null, createdAt: Date.parse('2026-01-01T00:00:00Z'), expiresAt: null, ...NO_POPUP },
      { id: 3, title: 'Update', body: 'v1.1', url: 'https://x.id', createdAt: 0, expiresAt: null, ...NO_POPUP }
    ])
    assert.deepEqual(calls[0].params, [2])
    assert.match(calls[0].sql, /active/)
    assert.match(calls[0].sql, /expires_at/)
  })

  it('active: kind memilih info (bukan popup), popup saja, atau semua', async () => {
    const info = fakePool({ rows: [] })
    await new AnnouncementRepo(info.pool).active(5, 'info')
    assert.match(info.calls[0].sql, /AND NOT popup/)
    const pop = fakePool({ rows: [] })
    await new AnnouncementRepo(pop.pool).active(5, 'popup')
    assert.match(pop.calls[0].sql, /AND popup/)
    assert.doesNotMatch(pop.calls[0].sql, /NOT popup/)
    const all = fakePool({ rows: [] })
    await new AnnouncementRepo(all.pool).active(5)
    assert.doesNotMatch(all.calls[0].sql, /AND (NOT )?popup/)
  })

  it('create: merapikan spasi dan mengisi null untuk field opsional', async () => {
    const { pool, calls } = fakePool({ rows: [{ id: 1, title: 'Judul', body: '', url: null }] })
    const out = await new AnnouncementRepo(pool).create({ title: '  Judul  ' })
    assert.deepEqual(calls[0].params, ['Judul', '', null, null, false, null, null, null, null])
    assert.equal(out.id, 1)
    assert.equal(out.popup, false)
  })

  it('create: popup pembaruan dengan gambar, versi, dan teks tombol', async () => {
    const { pool, calls } = fakePool({ rows: [{ id: 2, title: 'v2.6', popup: true, image_url: 'https://i/x.jpg', version: '2.6.0', button_text: 'Unduh', cancel_text: '' }] })
    const out = await new AnnouncementRepo(pool).create({ title: 'v2.6', url: 'https://x.id/apk', popup: true, imageUrl: 'https://i/x.jpg', version: ' 2.6.0 ', buttonText: 'Unduh', cancelText: '  ' })
    assert.deepEqual(calls[0].params, ['v2.6', '', 'https://x.id/apk', null, true, 'https://i/x.jpg', '2.6.0', 'Unduh', null])
    assert.equal(out.popup, true)
    assert.equal(out.version, '2.6.0')
    assert.equal(out.imageUrl, 'https://i/x.jpg')
  })

  it('remove: true bila ada baris terhapus, false bila tidak', async () => {
    assert.equal(await new AnnouncementRepo(fakePool({ rowCount: 1 }).pool).remove(1), true)
    assert.equal(await new AnnouncementRepo(fakePool({ rowCount: 0 }).pool).remove(1), false)
  })
})

describe('tokenMatches', () => {
  it('hanya cocok untuk token yang persis sama', () => {
    assert.equal(tokenMatches('rahasia', 'rahasia'), true)
    assert.equal(tokenMatches('salah!!', 'rahasia'), false)
    assert.equal(tokenMatches('pendek', 'rahasia-panjang'), false)
  })
  it('admin nonaktif (token kosong) atau header bukan string -> selalu ditolak', () => {
    assert.equal(tokenMatches('', ''), false)
    assert.equal(tokenMatches('apa-saja', ''), false)
    assert.equal(tokenMatches(undefined, 'rahasia'), false)
    assert.equal(tokenMatches(['rahasia'], 'rahasia'), false)
  })
})

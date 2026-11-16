import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRegistration, hashPassword, signToken, slugUsername, verifyPassword, verifyToken } from '../src/core/auth.js'
import { AuthService } from '../src/services/auth.js'

test('password: hash unik per panggilan, verifikasi benar/salah', async () => {
  const a = await hashPassword('rahasia123')
  const b = await hashPassword('rahasia123')
  assert.notEqual(a, b)
  assert.ok(await verifyPassword('rahasia123', a))
  assert.ok(!(await verifyPassword('rahasia124', a)))
  assert.ok(!(await verifyPassword('x', 'bukan-hash')))
})

test('token: valid, kedaluwarsa, dirusak, secret lain', () => {
  const now = 1_700_000_000_000
  const t = signToken(7, 's3cret', 60, now)
  assert.deepEqual(verifyToken(t, 's3cret', now + 1000), { sub: 7 })
  assert.equal(verifyToken(t, 's3cret', now + 61_000), null)
  assert.equal(verifyToken(t, 'lain', now), null)
  const [h, , s] = t.split('.')
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 1, exp: 9_999_999_999 })).toString('base64url')}.${s}`
  assert.equal(verifyToken(forged, 's3cret', now), null)
  assert.equal(verifyToken('a.b', 's3cret', now), null)
})

test('validasi registrasi & slug username', () => {
  assert.equal(checkRegistration('budi_01', 'budi@mail.com', 'password1'), null)
  assert.match(checkRegistration('a', 'budi@mail.com', 'password1')!, /Username/)
  assert.match(checkRegistration('budi', 'bukan-email', 'password1')!, /email/i)
  assert.match(checkRegistration('budi', 'budi@mail.com', 'pendek')!, /8 karakter/)
  assert.equal(slugUsername('Budi Santoso!'), 'BudiSantoso')
  assert.ok(slugUsername('!!').length >= 3)
})

// ---- service dengan pool tiruan ----
function fakes() {
  const users: any[] = []
  const pool = {
    async query(sql: string, p: any[] = []) {
      if (sql.startsWith('INSERT INTO users (username, email, password_hash)')) {
        if (users.some(u => u.username.toLowerCase() === p[0].toLowerCase())) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'users_username_lower' })
        const u = { id: users.length + 1, username: p[0], email: p[1], password_hash: p[2] }
        users.push(u)
        return { rows: [u] }
      }
      if (sql.includes('lower(username) = lower($1)')) return { rows: users.filter(u => u.username.toLowerCase() === p[0].toLowerCase() || u.email?.toLowerCase() === p[0].toLowerCase()).slice(0, 1) }
      if (sql.includes('WHERE id = $1')) return { rows: users.filter(u => u.id === p[0]) }
      throw new Error(`sql tak dikenal: ${sql}`)
    }
  }
  return { users, pool }
}
const cfg = { jwtSecret: 'x', tokenTtlSec: 3600, googleClientId: '' }
const log = { warn() {}, error() {} }

test('register + login + me', async () => {
  const f = fakes()
  const svc = new AuthService(f.pool as any, cfg, log)
  const r = await svc.register('budi', 'budi@mail.com', 'password1')
  assert.equal(r.user.username, 'budi')
  assert.ok(!JSON.stringify(f.users[0]).includes('password1'))
  await assert.rejects(svc.register('Budi', 'lain@mail.com', 'password1'), /Username sudah dipakai/)
  const l = await svc.login('budi@mail.com', 'password1')
  assert.equal(l.user.id, r.user.id)
  await assert.rejects(svc.login('budi', 'salah-salah'), /salah/)
  await assert.rejects(svc.login('tidak-ada', 'password1'), /salah/)
  assert.equal((await svc.me(`Bearer ${l.token}`)).username, 'budi')
  await assert.rejects(svc.me('Bearer palsu'), /Sesi tidak valid/)
})

test('login Google tidak aktif bila tidak dikonfigurasi', async () => {
  const f = fakes()
  const svc = new AuthService(f.pool as any, { ...cfg, googleClientId: '' }, log)
  await assert.rejects(svc.google('abc'), /belum dikonfigurasi/)
})

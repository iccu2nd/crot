import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

/** Primitif auth tanpa dependensi: hash password (scrypt) + token HS256 (JWT). Murni, mudah diuji. */

const SCRYPT = { N: 16384, r: 8, p: 1 }
const scrypt = (pw: string, salt: Buffer, len: number): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(pw, salt, len, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))))

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, 64)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$')
  if (alg !== 'scrypt' || !s || !k) return false
  const want = Buffer.from(k, 'base64')
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length)
  return got.length === want.length && timingSafeEqual(got, want)
}

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url')

export function signToken(sub: number, secret: string, ttlSec: number, now = Date.now()): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const iat = Math.floor(now / 1000)
  const body = b64u(JSON.stringify({ sub, iat, exp: iat + ttlSec }))
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

export function verifyToken(token: string, secret: string, now = Date.now()): { sub: number } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, b, s] = parts
  const want = createHmac('sha256', secret).update(`${h}.${b}`).digest()
  const got = Buffer.from(s, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString())
    if (typeof p.sub !== 'number' || typeof p.exp !== 'number' || p.exp * 1000 < now) return null
    return { sub: p.sub }
  } catch {
    return null
  }
}

// ---- validasi input (pesan Indonesia, ditampilkan langsung di app) ----
export const USERNAME_RE = /^[A-Za-z0-9_.]{3,20}$/
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/

export function checkRegistration(username: string, email: string, password: string): string | null {
  if (!USERNAME_RE.test(username)) return 'Username 3–20 karakter: huruf, angka, titik, atau garis bawah'
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Format email tidak valid'
  if (password.length < 8) return 'Password minimal 8 karakter'
  if (password.length > 128) return 'Password terlalu panjang (maks. 128)'
  return null
}

/** Username otomatis dari nama bebas (dari email): hanya karakter yang diizinkan, 3–20 karakter. */
export function slugUsername(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_.]+/g, '').slice(0, 16)
  return s.length >= 3 ? s : `user${s}`.slice(0, 16)
}

import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { Config } from '../config.js'
import { checkRegistration, hashPassword, signToken, slugUsername, verifyPassword, verifyToken } from '../core/auth.js'
import { AppError, ConflictError, NotConfiguredError, UnauthorizedError, ValidationError } from '../core/errors.js'

export interface AuthUser {
  id: number
  username: string
  /** versi foto profil (0 = belum ada); dipakai app untuk URL /users/:id/avatar?v= */
  avatarV: number
}
export interface AuthResult {
  token: string
  user: AuthUser
}
type Log = { warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void }

const BAD_LOGIN = 'Username/email atau password salah'

/** Akun: daftar/masuk password dan Google (ID token). Token = JWT HS256. */
export class AuthService {
  private readonly secret: string
  /** hash palsu untuk menyamakan waktu respons saat user tidak ditemukan (anti enumerasi username). */
  private dummyHash?: Promise<string>

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config['auth'],
    private readonly log: Log,
    private readonly http: typeof fetch = fetch
  ) {
    if (!cfg.jwtSecret) {
      this.log.warn({}, 'JWT_SECRET kosong: memakai secret acak (token hilang saat restart). Isi JWT_SECRET di produksi!')
    }
    this.secret = cfg.jwtSecret || randomBytes(32).toString('hex')
  }

  get googleClientId() {
    return this.cfg.googleClientId || null
  }

  private issue(u: { id: number; username: string; avatarV?: number }): AuthResult {
    return { token: signToken(u.id, this.secret, this.cfg.tokenTtlSec), user: { id: u.id, username: u.username, avatarV: u.avatarV ?? 0 } }
  }

  // ------------------------------------------------------------------ password

  async register(username: string, email: string, password: string): Promise<AuthResult> {
    username = String(username ?? '').trim()
    email = String(email ?? '').trim()
    password = String(password ?? '')
    const bad = checkRegistration(username, email, password)
    if (bad) throw new ValidationError(bad)
    const hash = await hashPassword(password)
    try {
      const { rows } = await this.pool.query('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV"', [username, email, hash])
      return this.issue(rows[0])
    } catch (e) {
      const err = e as { code?: string; constraint?: string }
      if (err.code === '23505') throw new ConflictError(err.constraint === 'users_email_lower' ? 'Email sudah terdaftar' : 'Username sudah dipakai')
      throw e
    }
  }

  async login(identifier: string, password: string): Promise<AuthResult> {
    identifier = String(identifier ?? '').trim()
    password = String(password ?? '')
    if (!identifier || !password || password.length > 128) throw new UnauthorizedError(BAD_LOGIN)
    const { rows } = await this.pool.query('SELECT id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV", password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1', [identifier])
    const row = rows[0] as { id: number; username: string; avatarV: number; password_hash: string | null } | undefined
    this.dummyHash ??= hashPassword('dummy-password-for-timing')
    const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash))
    if (!row || !row.password_hash || !ok) throw new UnauthorizedError(BAD_LOGIN)
    return this.issue(row)
  }

  /** Akun dari header `Authorization: Bearer <token>`; 401 bila token salah/kedaluwarsa. */
  async me(authorization: string | undefined): Promise<AuthUser> {
    const m = /^Bearer (.+)$/.exec(authorization ?? '')
    const claims = m ? verifyToken(m[1], this.secret) : null
    if (!claims) throw new UnauthorizedError('Sesi tidak valid, silakan masuk lagi')
    const { rows } = await this.pool.query('SELECT id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV" FROM users WHERE id = $1', [claims.sub])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    return rows[0]
  }

  // ------------------------------------------------------------------ foto profil

  async setAvatar(userId: number, jpeg: Buffer): Promise<AuthUser> {
    const { rows } = await this.pool.query('UPDATE users SET avatar = $2, avatar_v = avatar_v + 1 WHERE id = $1 RETURNING id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV"', [userId, jpeg])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    return rows[0]
  }

  async clearAvatar(userId: number): Promise<AuthUser> {
    const { rows } = await this.pool.query('UPDATE users SET avatar = NULL, avatar_v = avatar_v + 1 WHERE id = $1 RETURNING id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV"', [userId])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    return rows[0]
  }

  async avatarOf(userId: number): Promise<Buffer | null> {
    const { rows } = await this.pool.query('SELECT avatar FROM users WHERE id = $1', [userId])
    return (rows[0]?.avatar as Buffer | null) ?? null
  }

  // ------------------------------------------------------------------ google

  async google(idToken: string): Promise<AuthResult> {
    const clientId = this.cfg.googleClientId
    if (!clientId) throw new NotConfiguredError('Masuk dengan Google belum dikonfigurasi di server')
    const res = await this.http(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(idToken ?? ''))}`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
    if (!res) throw new AppError(502, 'UPSTREAM_ERROR', 'Tidak bisa menghubungi Google')
    if (!res.ok) throw new UnauthorizedError('Token Google tidak valid')
    const t = (await res.json()) as Record<string, string>
    const issuerOk = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com'
    if (t.aud !== clientId || !issuerOk || Number(t.exp) * 1000 < Date.now() || String(t.email_verified) !== 'true' || !t.sub || !t.email) {
      throw new UnauthorizedError('Token Google tidak valid')
    }
    // 1) sudah pernah masuk dengan Google  2) email sama dengan akun yang ada (email Google terverifikasi) -> tautkan  3) buat baru
    let { rows } = await this.pool.query('SELECT id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV" FROM users WHERE google_sub = $1', [t.sub])
    if (!rows[0]) {
      rows = (await this.pool.query('UPDATE users SET google_sub = $1 WHERE lower(email) = lower($2) AND google_sub IS NULL RETURNING id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV"', [t.sub, t.email])).rows
    }
    if (!rows[0]) {
      rows = [await this.createSocial({ google_sub: t.sub, email: t.email }, slugUsername(t.email.split('@')[0]))]
    }
    return this.issue(rows[0])
  }

  /** Buat user dari login Google; username bentrok -> tambah angka acak. */
  private async createSocial(cols: { google_sub?: string; email?: string }, base: string): Promise<AuthUser> {
    for (let i = 0; i < 6; i++) {
      const username = i === 0 ? base : `${base.slice(0, 16)}${Math.floor(Math.random() * 9000 + 1000)}`
      try {
        const { rows } = await this.pool.query(
          'INSERT INTO users (username, email, google_sub) VALUES ($1, $2, $3) RETURNING id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV"',
          [username, cols.email ?? null, cols.google_sub ?? null]
        )
        return rows[0]
      } catch (e) {
        const err = e as { code?: string; constraint?: string }
        if (err.code !== '23505') throw e
        if (err.constraint === 'users_username_lower') continue
        // email / google_sub bentrok = balapan dua request: ambil yang sudah ada
        const { rows } = await this.pool.query('SELECT id, username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV" FROM users WHERE google_sub = $1 LIMIT 1', [cols.google_sub ?? null])
        if (rows[0]) return rows[0]
        throw new ConflictError('Email sudah terdaftar dengan akun lain')
      }
    }
    throw new ConflictError('Gagal membuat username, coba lagi')
  }
}

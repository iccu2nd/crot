import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { Config } from '../config.js'
import { levelFor } from '../core/xp.js'
import { USERNAME_MSG, USERNAME_RE, checkRegistration, formatCooldown, hashPassword, signToken, slugUsername, verifyPassword, verifyToken } from '../core/auth.js'
import { AppError, ConflictError, NotConfiguredError, NotFoundError, UnauthorizedError, ValidationError } from '../core/errors.js'

export interface AuthUser {
  id: number
  username: string
  /** nama tampilan bebas; '' = belum diisi (app memakai username) */
  displayName: string
  /** sisa detik cooldown ganti username saat respons dibuat (0 = boleh ganti sekarang) */
  usernameCooldownSec: number
  /** total XP, level, XP terkumpul di level ini, dan XP yang dibutuhkan untuk naik */
  xp: number
  level: number
  levelXp: number
  levelNeed: number
  /** versi foto profil (0 = belum ada); dipakai app untuk URL /users/:id/avatar?v= */
  avatarV: number
}
/** Profil yang boleh dilihat siapa saja (tanpa email/data akun). */
export interface PublicProfile {
  id: number
  username: string
  displayName: string
  avatarV: number
  xp: number
  level: number
  /** kapan akun dibuat (epoch ms) */
  joinedAt: number
  commentCount: number
}
export interface AuthResult {
  token: string
  user: AuthUser
}
type Log = { warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void }

const BAD_LOGIN = 'Username/email atau password salah'
/** Username hanya boleh diganti sekali per 7 hari. */
export const USERNAME_COOLDOWN_DAYS = 7
const COLS = `id, username, display_name AS "displayName", xp, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_v END AS "avatarV", COALESCE(GREATEST(0, CEIL(EXTRACT(EPOCH FROM (username_changed_at + interval '${USERNAME_COOLDOWN_DAYS} days' - now()))))::int, 0) AS "usernameCooldownSec"`

type Row = { id: number; username: string; displayName?: string | null; xp?: number; avatarV?: number; usernameCooldownSec?: number | string | null }
const toUser = (r: Row): AuthUser => {
  const xp = Number(r.xp ?? 0)
  const lv = levelFor(xp)
  return {
  id: r.id,
  username: r.username,
  displayName: r.displayName ?? '',
  avatarV: Number(r.avatarV ?? 0),
  usernameCooldownSec: Number(r.usernameCooldownSec ?? 0),
  xp,
  level: lv.level,
  levelXp: lv.into,
  levelNeed: lv.need
  }
}

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

  private issue(u: Row): AuthResult {
    return { token: signToken(u.id, this.secret, this.cfg.tokenTtlSec), user: toUser(u) }
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
      const { rows } = await this.pool.query('INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING ' + COLS, [username, email, hash])
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
    const { rows } = await this.pool.query('SELECT ' + COLS + ', password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1', [identifier])
    const row = rows[0] as { id: number; username: string; avatarV: number; password_hash: string | null } | undefined
    this.dummyHash ??= hashPassword('dummy-password-for-timing')
    const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash))
    if (!row || !row.password_hash || !ok) throw new UnauthorizedError(BAD_LOGIN)
    return this.issue(row)
  }

  /** Id pengguna dari token (tanpa query DB); null bila tidak ada/tidak valid. Untuk endpoint publik yang menyesuaikan tampilan per pengguna. */
  viewerId(authorization: string | undefined): number | null {
    const m = /^Bearer (.+)$/.exec(authorization ?? '')
    return (m ? verifyToken(m[1], this.secret) : null)?.sub ?? null
  }

  /** Akun dari header `Authorization: Bearer <token>`; 401 bila token salah/kedaluwarsa. */
  async me(authorization: string | undefined): Promise<AuthUser> {
    const m = /^Bearer (.+)$/.exec(authorization ?? '')
    const claims = m ? verifyToken(m[1], this.secret) : null
    if (!claims) throw new UnauthorizedError('Sesi tidak valid, silakan masuk lagi')
    const { rows } = await this.pool.query('SELECT ' + COLS + ' FROM users WHERE id = $1', [claims.sub])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    return toUser(rows[0])
  }

  // ------------------------------------------------------------------ profil: nama & username

  /**
   * Ubah nama tampilan dan/atau username. Nama bebas (maks. 30 karakter, kosong = hapus).
   * Username hanya boleh diganti bila sudah lewat 7 hari sejak penggantian terakhir (dicek atomik di SQL).
   */
  async updateProfile(userId: number, patch: { displayName?: string | null; username?: string | null }): Promise<AuthUser> {
    let setName = false
    let name: string | null = null
    if (patch.displayName != null) {
      name = String(patch.displayName).replace(/\s+/g, ' ').trim()
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(name)) throw new ValidationError('Nama mengandung karakter tidak valid')
      if ([...name].length > 30) throw new ValidationError('Nama maksimal 30 karakter')
      setName = true
      name = name || null
    }
    let setUser = false
    let username: string | null = null
    if (patch.username != null) {
      username = String(patch.username).trim()
      if (!USERNAME_RE.test(username)) throw new ValidationError(USERNAME_MSG)
      setUser = true
    }
    if (!setName && !setUser) throw new ValidationError('Tidak ada perubahan')

    if (setUser) {
      const { rows } = await this.pool.query('SELECT ' + COLS + ' FROM users WHERE id = $1', [userId])
      const now = rows[0] as Row | undefined
      if (!now) throw new UnauthorizedError('Akun tidak ditemukan')
      if (now.username === username) setUser = false // sama persis: tidak dihitung sebagai penggantian
      else if (Number(now.usernameCooldownSec ?? 0) > 0) throw this.cooldownError(Number(now.usernameCooldownSec))
      if (!setName && !setUser) return toUser(now)
    }

    try {
      const { rows } = await this.pool.query(
        `UPDATE users SET
           display_name = CASE WHEN $2::boolean THEN $3::text ELSE display_name END,
           username = CASE WHEN $4::boolean THEN $5::text ELSE username END,
           username_changed_at = CASE WHEN $4::boolean THEN now() ELSE username_changed_at END
         WHERE id = $1 AND (NOT $4::boolean OR username_changed_at IS NULL OR username_changed_at <= now() - interval '${USERNAME_COOLDOWN_DAYS} days')
         RETURNING ` + COLS,
        [userId, setName, name, setUser, username]
      )
      if (rows[0]) return toUser(rows[0])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('Username sudah dipakai')
      throw e
    }
    // 0 baris: akun hilang, atau balapan dengan penggantian lain -> baca ulang untuk pesan yang tepat
    const { rows } = await this.pool.query('SELECT ' + COLS + ' FROM users WHERE id = $1', [userId])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    throw this.cooldownError(Number(rows[0].usernameCooldownSec ?? 0))
  }

  private cooldownError(sec: number) {
    return new AppError(429, 'USERNAME_COOLDOWN', `Username baru bisa diganti lagi dalam ${formatCooldown(sec)}`)
  }

  // ------------------------------------------------------------------ profil publik

  async publicProfile(userId: number): Promise<PublicProfile> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.display_name AS "displayName", u.xp, u.created_at AS "createdAt",
              CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_v END AS "avatarV",
              (SELECT count(*)::int FROM comments c WHERE c.user_id = u.id) AS "commentCount"
         FROM users u WHERE u.id = $1`,
      [userId]
    )
    const r = rows[0]
    if (!r) throw new NotFoundError('Pengguna tidak ditemukan')
    const xp = Number(r.xp ?? 0)
    return {
      id: Number(r.id),
      username: r.username,
      displayName: r.displayName ?? '',
      avatarV: Number(r.avatarV ?? 0),
      xp,
      level: levelFor(xp).level,
      joinedAt: new Date(r.createdAt).getTime(),
      commentCount: Number(r.commentCount ?? 0)
    }
  }

  // ------------------------------------------------------------------ hapus akun

  /** Hapus akun permanen. Komentar, suara, dan riwayat XP ikut terhapus (ON DELETE CASCADE); tag "membalas" di balasan orang lain dikosongkan. */
  async deleteAccount(userId: number): Promise<void> {
    const { rowCount } = await this.pool.query('DELETE FROM users WHERE id = $1', [userId])
    if (!rowCount) throw new UnauthorizedError('Akun tidak ditemukan')
  }

  // ------------------------------------------------------------------ foto profil

  async setAvatar(userId: number, jpeg: Buffer): Promise<AuthUser> {
    const { rows } = await this.pool.query('UPDATE users SET avatar = $2, avatar_v = avatar_v + 1 WHERE id = $1 RETURNING ' + COLS, [userId, jpeg])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    return toUser(rows[0])
  }

  async clearAvatar(userId: number): Promise<AuthUser> {
    const { rows } = await this.pool.query('UPDATE users SET avatar = NULL, avatar_v = avatar_v + 1 WHERE id = $1 RETURNING ' + COLS, [userId])
    if (!rows[0]) throw new UnauthorizedError('Akun tidak ditemukan')
    return toUser(rows[0])
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
    let { rows } = await this.pool.query('SELECT ' + COLS + ' FROM users WHERE google_sub = $1', [t.sub])
    if (!rows[0]) {
      rows = (await this.pool.query('UPDATE users SET google_sub = $1 WHERE lower(email) = lower($2) AND google_sub IS NULL RETURNING ' + COLS, [t.sub, t.email])).rows
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
          'INSERT INTO users (username, email, google_sub) VALUES ($1, $2, $3) RETURNING ' + COLS,
          [username, cols.email ?? null, cols.google_sub ?? null]
        )
        return toUser(rows[0])
      } catch (e) {
        const err = e as { code?: string; constraint?: string }
        if (err.code !== '23505') throw e
        if (err.constraint === 'users_username_lower') continue
        // email / google_sub bentrok = balapan dua request: ambil yang sudah ada
        const { rows } = await this.pool.query('SELECT ' + COLS + ' FROM users WHERE google_sub = $1 LIMIT 1', [cols.google_sub ?? null])
        if (rows[0]) return toUser(rows[0])
        throw new ConflictError('Email sudah terdaftar dengan akun lain')
      }
    }
    throw new ConflictError('Gagal membuat username, coba lagi')
  }
}

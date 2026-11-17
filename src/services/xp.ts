import type { Pool } from 'pg'
import { ValidationError } from '../core/errors.js'
import { CLIENT_KINDS, XP_RULES, type XpKind } from '../core/xp.js'

const REF_RE = /^[a-z0-9_-]{2,20}:[^\s]{1,300}$/i
/** Tanggal hari ini di WIB (UTC+7), dipakai sebagai ref untuk bonus harian. */
const wibDay = (now = Date.now()) => new Date(now + 7 * 3600_000).toISOString().slice(0, 10)

/** Pemberian XP: tiap (user, jenis, ref) hanya sekali + batas harian per jenis; dicatat di xp_events. */
export class XpService {
  constructor(private readonly pool: Pool) {}

  /** Beri XP bila belum pernah & kuota harian belum habis. Mengembalikan XP yang didapat (0 = tidak ada). */
  async award(userId: number, kind: XpKind, ref: string): Promise<number> {
    const rule = XP_RULES[kind]
    const { rows } = await this.pool.query(
      `WITH ins AS (
         INSERT INTO xp_events (user_id, kind, ref, xp)
         SELECT $1::int, $2::text, $3::text, $4::int
         WHERE (SELECT count(*) FROM xp_events WHERE user_id = $1::int AND kind = $2::text AND day = ((now() AT TIME ZONE 'Asia/Jakarta')::date)) < $5::int
         ON CONFLICT (user_id, kind, ref) DO NOTHING
         RETURNING xp
       )
       UPDATE users SET xp = xp + (SELECT xp FROM ins) WHERE id = $1::int AND EXISTS (SELECT 1 FROM ins) RETURNING id`,
      [userId, kind, ref, rule.xp, rule.perDay]
    )
    return rows.length ? rule.xp : 0
  }

  /** Laporan dari app (baca chapter, tambah pustaka, buka harian). Jenis & ref divalidasi. */
  async report(userId: number, type: unknown, ref: unknown): Promise<number> {
    if (!CLIENT_KINDS.includes(type as never)) throw new ValidationError('Jenis aktivitas tidak valid')
    const kind = type as (typeof CLIENT_KINDS)[number]
    if (kind === 'daily') return this.award(userId, 'daily', wibDay())
    if (typeof ref !== 'string' || !REF_RE.test(ref)) throw new ValidationError('Referensi tidak valid')
    return this.award(userId, kind, ref)
  }
}

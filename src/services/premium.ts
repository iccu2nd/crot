import type { Pool } from 'pg'
import { AppError, ValidationError } from '../core/errors.js'
import { FRAMES, MAX_HEADER_BLUR, PREMIUM_XP_MULT, THEMES } from '../core/premium.js'

export interface StylePatch {
  theme?: string | null
  frame?: string | null
  headerBlur?: number
  headerPos?: number
}

/** Fitur Premium (tema, frame, header profil). Pembelian/pembayaran sudah dihapus; status Premium diberikan manual (admin/DB). */
export class PremiumService {
  constructor(private readonly pool: Pool) {}

  catalog() {
    return {
      enabled: false, // pembelian dinonaktifkan
      xpMultiplier: PREMIUM_XP_MULT,
      plans: [] as never[],
      methods: [] as never[],
      themes: [...THEMES],
      frames: [...FRAMES]
    }
  }


  /**
   * Tema, frame, blur & posisi background header. Mengubah (bukan mengosongkan) hanya untuk Premium aktif.
   * Kosong ('' / null) = kembali ke bawaan; boleh kapan saja.
   */
  async setStyle(userId: number, active: boolean, patch: StylePatch): Promise<void> {
    const setTheme = patch.theme !== undefined
    const theme = patch.theme ? String(patch.theme) : null
    if (theme && !(THEMES as readonly string[]).includes(theme)) throw new ValidationError('Tema tidak valid')
    const setFrame = patch.frame !== undefined
    const frame = patch.frame ? String(patch.frame) : null
    if (frame && !(FRAMES as readonly string[]).includes(frame)) throw new ValidationError('Frame tidak valid')
    const setBlur = patch.headerBlur !== undefined
    const setPos = patch.headerPos !== undefined
    const blur = Math.round(Number(patch.headerBlur ?? 0))
    const pos = Math.round(Number(patch.headerPos ?? 50))
    if (setBlur && !(blur >= 0 && blur <= MAX_HEADER_BLUR)) throw new ValidationError(`Blur harus 0–${MAX_HEADER_BLUR}`)
    if (setPos && !(pos >= 0 && pos <= 100)) throw new ValidationError('Posisi harus 0–100')
    if (!setTheme && !setFrame && !setBlur && !setPos) throw new ValidationError('Tidak ada perubahan')
    if (!active && (theme || frame || setBlur || setPos)) throw new AppError(403, 'PREMIUM_REQUIRED', 'Fitur ini khusus Premium')

    await this.pool.query(
      `UPDATE users SET
         theme = CASE WHEN $2::boolean THEN $3::text ELSE theme END,
         frame = CASE WHEN $4::boolean THEN $5::text ELSE frame END,
         header_blur = CASE WHEN $6::boolean THEN $7::smallint ELSE header_blur END,
         header_pos = CASE WHEN $8::boolean THEN $9::smallint ELSE header_pos END
       WHERE id = $1`,
      [userId, setTheme, theme, setFrame, frame, setBlur, blur, setPos, pos]
    )
  }

  async setHeader(userId: number, jpeg: Buffer): Promise<void> {
    await this.pool.query('UPDATE users SET header_bg = $2, header_v = header_v + 1 WHERE id = $1', [userId, jpeg])
  }

  async clearHeader(userId: number): Promise<void> {
    await this.pool.query('UPDATE users SET header_bg = NULL, header_v = header_v + 1 WHERE id = $1', [userId])
  }

  /** Gambar header; hanya dilayani selama pemiliknya Premium aktif. */
  async headerOf(userId: number): Promise<Buffer | null> {
    const { rows } = await this.pool.query(
      `SELECT header_bg FROM users WHERE id = $1 AND header_bg IS NOT NULL AND (premium OR (premium_until IS NOT NULL AND premium_until > now()))`,
      [userId]
    )
    return (rows[0]?.header_bg as Buffer | null) ?? null
  }
}

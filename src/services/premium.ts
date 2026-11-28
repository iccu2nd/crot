import type { Pool } from 'pg'
import { AppError, ValidationError } from '../core/errors.js'
import { FRAMES, THEMES } from '../core/premium.js'

export interface StylePatch {
  theme?: string | null
  frame?: string | null
}

export class PremiumService {
  constructor(private readonly pool: Pool) {}

  async setStyle(userId: number, active: boolean, patch: StylePatch): Promise<void> {
    const setTheme = patch.theme !== undefined
    const theme = patch.theme ? String(patch.theme) : null
    if (theme && !(THEMES as readonly string[]).includes(theme)) throw new ValidationError('Tema tidak valid')
    const setFrame = patch.frame !== undefined
    const frame = patch.frame ? String(patch.frame) : null
    if (frame && !(FRAMES as readonly string[]).includes(frame)) throw new ValidationError('Frame tidak valid')
    if (!setTheme && !setFrame) throw new ValidationError('Tidak ada perubahan')
    if (!active && (theme || frame)) throw new AppError(403, 'PREMIUM_REQUIRED', 'Fitur ini khusus Premium')

    await this.pool.query(
      `UPDATE users SET
         theme = CASE WHEN $2::boolean THEN $3::text ELSE theme END,
         frame = CASE WHEN $4::boolean THEN $5::text ELSE frame END
       WHERE id = $1`,
      [userId, setTheme, theme, setFrame, frame]
    )
  }
}

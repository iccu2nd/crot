import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { AppError, NotFoundError, ValidationError } from '../core/errors.js'
import { assertBlobAllowed, type StorageGuard } from './storage/policy.js'

export const STICKER_RE = /^\[\[stk:(\d{1,9})\]\]$/
export const MAX_STICKER_BYTES = 400 * 1024
export const MAX_MINE = 30
export const MAX_GLOBAL = 300

export const sniffImage = (b: unknown): string | null => {
  if (!Buffer.isBuffer(b) || b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

export const stickerText = (body: string): string => (STICKER_RE.test(body) ? 'Stiker' : body)

export async function assertStickerUsable(pool: Pool, userId: number, body: string): Promise<boolean> {
  const m = STICKER_RE.exec(body)
  if (!m) return false
  const { rows } = await pool.query('SELECT 1 FROM stickers WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2)', [Number(m[1]), userId])
  if (!rows[0]) throw new ValidationError('Stiker tidak tersedia')
  return true
}

export class StickerService {
  constructor(
    private readonly pool: Pool,
    private readonly guard?: StorageGuard
  ) {}

  async list(ownerId: number | null): Promise<{ id: number }[]> {
    const { rows } = await this.pool.query(
      ownerId == null ? 'SELECT id FROM stickers WHERE owner_id IS NULL ORDER BY id DESC' : 'SELECT id FROM stickers WHERE owner_id = $1 ORDER BY id DESC',
      ownerId == null ? [] : [ownerId]
    )
    return rows.map(r => ({ id: Number(r.id) }))
  }

  async add(ownerId: number | null, img: unknown): Promise<{ id: number }> {
    const mime = sniffImage(img)
    if (!mime) throw new ValidationError('Format stiker harus PNG, WebP, JPEG, atau GIF')
    const buf = img as Buffer
    if (buf.length > MAX_STICKER_BYTES) throw new ValidationError('Stiker terlalu besar (maks. 400 KB)')
    const hash = createHash('sha256').update(buf).digest()
    const dup = await this.pool.query(
      ownerId == null ? 'SELECT id FROM stickers WHERE owner_id IS NULL AND content_hash = $1 LIMIT 1' : 'SELECT id FROM stickers WHERE owner_id = $2 AND content_hash = $1 LIMIT 1',
      ownerId == null ? [hash] : [hash, ownerId]
    )
    if (dup.rows[0]) return { id: Number(dup.rows[0].id) }
    await assertBlobAllowed(this.guard, buf.length, MAX_STICKER_BYTES)
    const cap = ownerId == null ? MAX_GLOBAL : MAX_MINE
    const n = await this.pool.query(ownerId == null ? 'SELECT count(*)::int AS n FROM stickers WHERE owner_id IS NULL' : 'SELECT count(*)::int AS n FROM stickers WHERE owner_id = $1', ownerId == null ? [] : [ownerId])
    if (Number(n.rows[0]?.n ?? 0) >= cap) throw new AppError(409, 'LIMIT_REACHED', `Batas stiker tercapai (maks. ${cap})`)
    const { rows } = await this.pool.query('INSERT INTO stickers (owner_id, image, mime, content_hash) VALUES ($1, $2, $3, $4) RETURNING id', [ownerId, buf, mime, hash])
    return { id: Number(rows[0].id) }
  }

  async remove(id: number, ownerId: number | null): Promise<void> {
    const r = await this.pool.query(
      ownerId == null ? 'DELETE FROM stickers WHERE id = $1 AND owner_id IS NULL' : 'DELETE FROM stickers WHERE id = $1 AND owner_id = $2',
      ownerId == null ? [id] : [id, ownerId]
    )
    if (!r.rowCount) throw new NotFoundError('Stiker tidak ditemukan')
  }

  async image(id: number): Promise<{ data: Buffer; mime: string } | null> {
    const { rows } = await this.pool.query('SELECT image, mime FROM stickers WHERE id = $1', [id])
    return rows[0] ? { data: rows[0].image as Buffer, mime: String(rows[0].mime) } : null
  }
}

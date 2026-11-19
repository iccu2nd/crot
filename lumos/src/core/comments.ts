import { ValidationError } from './errors.js'

/** "s:<provider>:<ref>" (seri) atau "c:<provider>:<ref>" (chapter). */
export const TARGET_RE = /^[sc]:[a-z0-9_-]{2,20}:[^\s]{1,300}$/i
export const MAX_COMMENT = 1000

export function checkTarget(t: unknown): string {
  if (typeof t !== 'string' || !TARGET_RE.test(t)) throw new ValidationError('Target komentar tidak valid')
  return t
}

/** Rapikan isi komentar: buang karakter kontrol, batasi baris kosong beruntun, wajib 1–1000 karakter. */
export function cleanComment(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!s) throw new ValidationError('Komentar tidak boleh kosong')
  if (s.length > MAX_COMMENT) throw new ValidationError(`Komentar terlalu panjang (maks. ${MAX_COMMENT} karakter)`)
  return s
}

export const MAX_AVATAR_BYTES = 300 * 1024
/** Foto profil hanya JPEG (app mengubah ukuran & mengonversi sebelum upload). */
export const isJpeg = (b: unknown): b is Buffer => Buffer.isBuffer(b) && b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

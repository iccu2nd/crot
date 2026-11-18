import type { Pool } from 'pg'

export interface Announcement {
  id: number
  title: string
  body: string
  url: string | null
  /** epoch ms */
  createdAt: number
  /** epoch ms; null = tidak kedaluwarsa */
  expiresAt: number | null
  /** true = aplikasi menampilkannya sebagai popup di tengah layar (sekali per pengumuman) */
  popup: boolean
  imageUrl: string | null
  /** Versi aplikasi yang diumumkan (mis. "2.6.0"): popup disembunyikan otomatis bila aplikasi sudah semuanya >= versi ini */
  version: string | null
  buttonText: string | null
  cancelText: string | null
}

export type AnnouncementKind = 'info' | 'popup' | 'all'

export interface NewAnnouncement {
  title: string
  body?: string
  url?: string | null
  /** ISO-8601; kosong = tidak kedaluwarsa */
  expiresAt?: string | null
  popup?: boolean
  imageUrl?: string | null
  version?: string | null
  buttonText?: string | null
  cancelText?: string | null
}

const toAnnouncement = (r: Record<string, any>): Announcement => ({
  id: Number(r.id),
  title: String(r.title),
  body: String(r.body ?? ''),
  url: r.url ?? null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
  expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
  popup: Boolean(r.popup),
  imageUrl: r.image_url ?? null,
  version: r.version ?? null,
  buttonText: r.button_text ?? null,
  cancelText: r.cancel_text ?? null
})

const COLS = 'id, title, body, url, created_at, expires_at, popup, image_url, version, button_text, cancel_text'
const blank = (v?: string | null) => (v && v.trim() ? v.trim() : null)

/** Pengumuman untuk aplikasi. Tabel kecil, jadi langsung ke PostgreSQL tanpa cache. */
export class AnnouncementRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Yang aktif & belum kedaluwarsa, terbaru dulu. `kind`: info = pengumuman biasa (tab Informasi), popup = popup/info pembaruan
   * (tab Pembaruan admin & popup di aplikasi), all = keduanya.
   */
  async active(limit = 5, kind: AnnouncementKind = 'all'): Promise<Announcement[]> {
    const only = kind === 'popup' ? 'AND popup' : kind === 'info' ? 'AND NOT popup' : ''
    const { rows } = await this.pool.query(
      `SELECT ${COLS} FROM announcements
       WHERE active AND (expires_at IS NULL OR expires_at > now()) ${only}
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit]
    )
    return rows.map(toAnnouncement)
  }

  async create(a: NewAnnouncement): Promise<Announcement> {
    const { rows } = await this.pool.query(
      `INSERT INTO announcements (title, body, url, expires_at, popup, image_url, version, button_text, cancel_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLS}`,
      [a.title.trim(), (a.body ?? '').trim(), blank(a.url), a.expiresAt ?? null, Boolean(a.popup), blank(a.imageUrl), blank(a.version), blank(a.buttonText), blank(a.cancelText)]
    )
    return toAnnouncement(rows[0])
  }

  async remove(id: number): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM announcements WHERE id = $1', [id])
    return (res.rowCount ?? 0) > 0
  }
}

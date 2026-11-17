import type { Pool } from 'pg'

export interface Announcement {
  id: number
  title: string
  body: string
  url: string | null
  /** epoch ms */
  createdAt: number
}

export interface NewAnnouncement {
  title: string
  body?: string
  url?: string | null
  /** ISO-8601; kosong = tidak kedaluwarsa */
  expiresAt?: string | null
}

const toAnnouncement = (r: Record<string, any>): Announcement => ({
  id: Number(r.id),
  title: String(r.title),
  body: String(r.body ?? ''),
  url: r.url ?? null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : 0
})

/** Pengumuman untuk aplikasi. Tabel kecil, jadi langsung ke PostgreSQL tanpa cache. */
export class AnnouncementRepo {
  constructor(private readonly pool: Pool) {}

  /** Yang aktif & belum kedaluwarsa, terbaru dulu. */
  async active(limit = 5): Promise<Announcement[]> {
    const { rows } = await this.pool.query(
      `SELECT id, title, body, url, created_at FROM announcements
       WHERE active AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit]
    )
    return rows.map(toAnnouncement)
  }

  async create(a: NewAnnouncement): Promise<Announcement> {
    const { rows } = await this.pool.query(
      `INSERT INTO announcements (title, body, url, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, body, url, created_at`,
      [a.title.trim(), (a.body ?? '').trim(), a.url ?? null, a.expiresAt ?? null]
    )
    return toAnnouncement(rows[0])
  }

  async remove(id: number): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM announcements WHERE id = $1', [id])
    return (res.rowCount ?? 0) > 0
  }
}

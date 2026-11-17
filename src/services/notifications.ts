import type { Pool } from 'pg'

export interface NotificationItem {
  /** unik per kejadian: `r<id balasan>` atau `l<id komentar>:<id penyuka>` */
  id: string
  kind: 'reply' | 'like'
  /** epoch ms */
  at: number
  /** lebih baru dari `seenAt` */
  unread: boolean
  /** `s:<id seri>` / `c:<id chapter>` — tempat komentarnya berada */
  target: string
  /** reply: isi balasan; like: isi komentar kita yang disukai (dipotong) */
  text: string
  actor: { id: number; username: string; displayName: string; avatarV: number }
}

export interface NotificationPage {
  /** epoch ms terakhir notifikasi ditandai dibaca (dipakai app untuk menandai Informasi yang belum dibaca) */
  seenAt: number
  items: NotificationItem[]
}

const SNIPPET = 140
const snip = (s: unknown) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return [...t].length > SNIPPET ? [...t].slice(0, SNIPPET).join('') + '…' : t
}

/** Balasan terhadap komentar kita (balasan di komentar teratas kita, atau balasan yang menyebut kita). */
const REPLY_COND = `c.user_id <> $1 AND (c.reply_to_user_id = $1 OR EXISTS (SELECT 1 FROM comments p WHERE p.id = c.parent_id AND p.user_id = $1))`

/** Notifikasi akun: balasan & like pada komentar kita. Pengumuman admin (Informasi) datang dari AnnouncementRepo. */
export class NotificationService {
  constructor(private readonly pool: Pool) {}

  async list(userId: number, limit = 50): Promise<NotificationPage> {
    const { rows } = await this.pool.query(
      `SELECT x.*, (SELECT notif_seen_at FROM users WHERE id = $1) AS seen FROM (
         SELECT 'reply' AS kind, 'r' || c.id AS id, c.created_at AS at, c.target, c.body AS text,
                u.id AS uid, u.username, u.display_name, CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_v END AS avatar_v
           FROM comments c JOIN users u ON u.id = c.user_id
          WHERE ${REPLY_COND}
         UNION ALL
         SELECT 'like', 'l' || v.comment_id || ':' || v.user_id, v.created_at, cm.target, cm.body,
                u.id, u.username, u.display_name, CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_v END
           FROM comment_votes v JOIN comments cm ON cm.id = v.comment_id JOIN users u ON u.id = v.user_id
          WHERE cm.user_id = $1 AND v.user_id <> $1 AND v.value = 1 AND v.created_at IS NOT NULL
       ) x ORDER BY x.at DESC LIMIT $2`,
      [userId, limit]
    )
    let seen = 0
    if (rows.length) seen = new Date(rows[0].seen).getTime()
    else {
      const r = await this.pool.query('SELECT notif_seen_at FROM users WHERE id = $1', [userId])
      seen = r.rows[0] ? new Date(r.rows[0].notif_seen_at).getTime() : 0
    }
    return {
      seenAt: seen,
      items: rows.map(r => {
        const at = new Date(r.at).getTime()
        return {
          id: String(r.id),
          kind: r.kind === 'like' ? 'like' : 'reply',
          at,
          unread: at > seen,
          target: String(r.target),
          text: snip(r.text),
          actor: { id: Number(r.uid), username: r.username, displayName: r.display_name ?? '', avatarV: Number(r.avatar_v ?? 0) }
        } as NotificationItem
      })
    }
  }

  /** Jumlah belum dibaca: balasan + like + pengumuman aktif yang lebih baru dari `notif_seen_at`. */
  async unreadCount(userId: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT (
         (SELECT count(*) FROM comments c WHERE c.created_at > u.notif_seen_at AND ${REPLY_COND.replace(/\$1/g, 'u.id')})
       + (SELECT count(*) FROM comment_votes v JOIN comments cm ON cm.id = v.comment_id
           WHERE v.created_at > u.notif_seen_at AND v.value = 1 AND v.user_id <> u.id AND cm.user_id = u.id)
       + (SELECT count(*) FROM announcements a WHERE a.active AND (a.expires_at IS NULL OR a.expires_at > now()) AND a.created_at > u.notif_seen_at)
       )::int AS n FROM users u WHERE u.id = $1`,
      [userId]
    )
    return Number(rows[0]?.n ?? 0)
  }

  async markRead(userId: number): Promise<void> {
    await this.pool.query('UPDATE users SET notif_seen_at = now() WHERE id = $1', [userId])
  }
}

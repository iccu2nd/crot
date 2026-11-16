import type { Pool } from 'pg'
import { checkTarget, cleanComment } from '../core/comments.js'
import { NotFoundError } from '../core/errors.js'

export interface CommentItem {
  id: number
  body: string
  createdAt: number
  user: { id: number; username: string; avatarV: number }
}

const toItem = (r: any): CommentItem => ({
  id: Number(r.id),
  body: r.body,
  createdAt: new Date(r.created_at).getTime(),
  user: { id: Number(r.uid), username: r.username, avatarV: Number(r.avatar_v ?? 0) }
})

const SELECT = `SELECT c.id, c.body, c.created_at, u.id AS uid, u.username, CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_v END AS avatar_v
                FROM comments c JOIN users u ON u.id = c.user_id`

/** Komentar per target (seri / chapter): terbaru dulu, paginasi keyset (`before` = id terakhir yang sudah dimuat). */
export class CommentService {
  constructor(private readonly pool: Pool) {}

  async list(target: unknown, limit = 20, before?: number): Promise<{ total: number; items: CommentItem[] }> {
    const t = checkTarget(target)
    const n = Math.min(Math.max(Math.floor(limit) || 20, 1), 50)
    const [items, total] = await Promise.all([
      this.pool.query(`${SELECT} WHERE c.target = $1 AND ($2::bigint IS NULL OR c.id < $2) ORDER BY c.id DESC LIMIT $3`, [t, before ?? null, n]),
      this.pool.query('SELECT count(*)::int AS n FROM comments WHERE target = $1', [t])
    ])
    return { total: total.rows[0]?.n ?? 0, items: items.rows.map(toItem) }
  }

  async add(userId: number, target: unknown, body: unknown): Promise<CommentItem> {
    const t = checkTarget(target)
    const text = cleanComment(body)
    const { rows } = await this.pool.query('INSERT INTO comments (target, user_id, body) VALUES ($1, $2, $3) RETURNING id', [t, userId, text])
    const full = await this.pool.query(`${SELECT} WHERE c.id = $1`, [rows[0].id])
    return toItem(full.rows[0])
  }

  /** Hanya penulis yang bisa menghapus komentarnya. */
  async remove(userId: number, id: number): Promise<void> {
    const { rowCount } = await this.pool.query('DELETE FROM comments WHERE id = $1 AND user_id = $2', [id, userId])
    if (!rowCount) throw new NotFoundError('Komentar tidak ditemukan')
  }
}

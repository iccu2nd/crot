import type { Pool } from 'pg'
import { checkTarget, cleanComment } from '../core/comments.js'
import { NotFoundError, ValidationError } from '../core/errors.js'

export interface CommentItem {
  id: number; body: string; createdAt: number; parentId: number | null
  likes: number; dislikes: number; myReaction: 'like' | 'dislike' | null
  user: { id: number; username: string; displayName: string; avatarV: number; xp: number; level: number }
}
const xpForLevel = (level:number) => Math.max(0,Math.floor((level-1)*(100+level*35)/2))
const levelForXp = (xp:number) => { let level=1; while(level<999 && xp>=xpForLevel(level+1)) level++; return level }
const toItem = (r: any): CommentItem => ({
  id: Number(r.id), body: r.body, createdAt: new Date(r.created_at).getTime(), parentId: r.parent_id == null ? null : Number(r.parent_id),
  likes: Number(r.likes ?? 0), dislikes: Number(r.dislikes ?? 0), myReaction: r.my_reaction ?? null,
  user: { id: Number(r.uid), username: r.username, displayName: r.display_name || r.username, avatarV: Number(r.avatar_v ?? 0), xp: Number(r.xp ?? 0), level: levelForXp(Number(r.xp ?? 0)) }
})
const SELECT = `SELECT c.id,c.body,c.created_at,c.parent_id,u.id AS uid,u.username,u.display_name,u.xp,
 CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_v END AS avatar_v,
 (SELECT count(*)::int FROM comment_reactions r WHERE r.comment_id=c.id AND r.kind='like') AS likes,
 (SELECT count(*)::int FROM comment_reactions r WHERE r.comment_id=c.id AND r.kind='dislike') AS dislikes,
 (SELECT kind FROM comment_reactions r WHERE r.comment_id=c.id AND r.user_id=$2) AS my_reaction
 FROM comments c JOIN users u ON u.id=c.user_id`
export class CommentService {
  constructor(private readonly pool: Pool) {}
  async list(target: unknown, limit = 20, before?: number, viewerId: number | null = null): Promise<{ total: number; items: CommentItem[] }> {
    const t = checkTarget(target), n = Math.min(Math.max(Math.floor(limit) || 20, 1), 50)
    const [items,total] = await Promise.all([
      this.pool.query(`${SELECT} WHERE c.target = $1 AND ($3::bigint IS NULL OR c.id < $3) ORDER BY c.id DESC LIMIT $4`,[t,viewerId,before ?? null,n]),
      this.pool.query('SELECT count(*)::int AS n FROM comments WHERE target=$1',[t])
    ])
    return { total: total.rows[0]?.n ?? 0, items: items.rows.map(toItem) }
  }
  async add(userId: number, target: unknown, body: unknown, parentId?: number | null): Promise<CommentItem> {
    const t=checkTarget(target), text=cleanComment(body)
    if (parentId != null) {
      const parent=await this.pool.query('SELECT target FROM comments WHERE id=$1',[parentId])
      if (!parent.rows[0] || parent.rows[0].target !== t) throw new NotFoundError('Komentar induk tidak ditemukan')
    }
    const {rows}=await this.pool.query('INSERT INTO comments(target,user_id,body,parent_id) VALUES($1,$2,$3,$4) RETURNING id',[t,userId,text,parentId ?? null])
    const full=await this.pool.query(`${SELECT} WHERE c.id = $1`,[rows[0].id,userId])
    return toItem(full.rows[0])
  }
  async react(userId:number,id:number,kind:unknown):Promise<{likes:number;dislikes:number;myReaction:string|null}> {
    if (kind !== null && kind !== 'like' && kind !== 'dislike') throw new ValidationError('Reaksi tidak valid')
    const exists=await this.pool.query('SELECT id FROM comments WHERE id=$1',[id]); if(!exists.rows[0]) throw new NotFoundError('Komentar tidak ditemukan')
    if(kind===null) await this.pool.query('DELETE FROM comment_reactions WHERE comment_id=$1 AND user_id=$2',[id,userId])
    else { const old=await this.pool.query('SELECT kind FROM comment_reactions WHERE comment_id=$1 AND user_id=$2',[id,userId]); if(old.rows[0]?.kind===kind) await this.pool.query('DELETE FROM comment_reactions WHERE comment_id=$1 AND user_id=$2',[id,userId]); else await this.pool.query(`INSERT INTO comment_reactions(comment_id,user_id,kind) VALUES($1,$2,$3) ON CONFLICT(comment_id,user_id) DO UPDATE SET kind=EXCLUDED.kind`,[id,userId,kind]) }
    const {rows}=await this.pool.query(`SELECT count(*) FILTER(WHERE kind='like')::int likes,count(*) FILTER(WHERE kind='dislike')::int dislikes,max(kind) FILTER(WHERE user_id=$2) my_reaction FROM comment_reactions WHERE comment_id=$1`,[id,userId])
    const r=rows[0]; return {likes:r.likes,dislikes:r.dislikes,myReaction:r.my_reaction}
  }
  async remove(userId:number,id:number):Promise<void>{const {rowCount}=await this.pool.query('DELETE FROM comments WHERE id=$1 AND user_id=$2',[id,userId]);if(!rowCount)throw new NotFoundError('Komentar tidak ditemukan')}
}

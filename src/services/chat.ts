import type { Pool } from 'pg'
import { AppError, NotFoundError, ValidationError } from '../core/errors.js'
import { levelFor } from '../core/xp.js'

/** Jumlah pesan yang disimpan & dikirim ke app. Yang lebih lama dihapus otomatis tiap ada pesan baru. */
export const CHAT_KEEP = 50
export const MAX_CHAT = 500
/** Maks. pesan per akun dalam 10 detik (rate limit per IP saja tidak cukup bila IP berganti-ganti / banyak user satu IP). */
const BURST = 5

export interface ChatItem {
  id: number
  body: string
  createdAt: number
  /** bentuk sama dengan `user` pada komentar, supaya app memakai lencana/level yang sama */
  user: { id: number; username: string; displayName: string; avatarV: number; level: number; verified: boolean; isOwner: boolean; premium: boolean }
}

const SELECT = `SELECT m.id, m.body, m.created_at, u.id AS uid, u.username, u.email, u.display_name, u.xp, u.verified, u.premium, u.verified_hidden,
                CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_v END AS avatar_v
                FROM chat_messages m JOIN users u ON u.id = m.user_id`

/** Rapikan pesan: buang karakter kontrol, maks. 1 baris kosong beruntun, wajib 1–500 karakter. */
export function cleanChat(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!s) throw new ValidationError('Pesan tidak boleh kosong')
  if (s.length > MAX_CHAT) throw new ValidationError(`Pesan terlalu panjang (maks. ${MAX_CHAT} karakter)`)
  return s
}

export class ChatService {
  constructor(
    private readonly pool: Pool,
    private readonly ownerEmails: string[] = []
  ) {}

  private item(r: any): ChatItem {
    const email = String(r.email ?? '').toLowerCase()
    const isOwner = !!email && this.ownerEmails.includes(email)
    return {
      id: Number(r.id),
      body: r.body,
      createdAt: new Date(r.created_at).getTime(),
      user: {
        id: Number(r.uid), username: r.username, displayName: r.display_name ?? '', avatarV: Number(r.avatar_v ?? 0),
        level: levelFor(Number(r.xp ?? 0)).level, verified: (r.verified === true || isOwner) && r.verified_hidden !== true, isOwner, premium: r.premium === true
      }
    }
  }

  /** `CHAT_KEEP` pesan terakhir, urut lama → baru. */
  async list(): Promise<ChatItem[]> {
    const { rows } = await this.pool.query(`${SELECT} ORDER BY m.id DESC LIMIT $1`, [CHAT_KEEP])
    return rows.reverse().map(r => this.item(r))
  }

  /** Kirim pesan, lalu langsung hapus semua pesan yang lebih lama dari `CHAT_KEEP` terbaru (tabel tak pernah membengkak). */
  async add(userId: number, body: unknown): Promise<ChatItem> {
    const text = cleanChat(body)
    const recent = await this.pool.query("SELECT count(*)::int AS n FROM chat_messages WHERE user_id = $1 AND created_at > now() - interval '10 seconds'", [userId])
    if (Number(recent.rows[0]?.n ?? 0) >= BURST) throw new AppError(429, 'RATE_LIMITED', 'Terlalu cepat, tunggu sebentar sebelum mengirim lagi')
    const { rows } = await this.pool.query('INSERT INTO chat_messages (user_id, body) VALUES ($1, $2) RETURNING id', [userId, text])
    // Pemangkasan tak boleh menggagalkan pengiriman; bila gagal, list() tetap hanya memberi 50 dan pangkas berikutnya menyusul.
    await this.pool
      .query('DELETE FROM chat_messages WHERE id <= (SELECT id FROM chat_messages ORDER BY id DESC OFFSET $1 LIMIT 1)', [CHAT_KEEP])
      .catch(() => {})
    const full = await this.pool.query(`${SELECT} WHERE m.id = $1`, [rows[0].id])
    return this.item(full.rows[0])
  }

  /** Hapus pesan sendiri; owner boleh menghapus pesan siapa pun. */
  async remove(userId: number, isOwner: boolean, id: number): Promise<void> {
    const r = await this.pool.query('DELETE FROM chat_messages WHERE id = $1 AND ($2::boolean OR user_id = $3)', [id, isOwner, userId])
    if (!r.rowCount) throw new NotFoundError('Pesan tidak ditemukan')
  }
}

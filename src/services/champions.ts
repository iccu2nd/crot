import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'
import { weekWindow } from '../core/xp.js'

/** Pengirim push juara (diimplementasi PushService). Mengembalikan true bila benar-benar terkirim. */
export interface ChampionNotifier {
  readonly configured: boolean
  champion(userId: number, rank: number, weekXp: number): Promise<boolean>
}

export interface ChampionHistory {
  /** jumlah minggu menjadi juara 1 / 2 / 3 */
  first: number
  second: number
  third: number
  /** juara terbaru dulu (maks. 8): `weekStart` = Senin 00.00 WIB (epoch ms) minggu itu */
  recent: { weekStart: number; rank: number; weekXp: number }[]
}

export interface FinalizeResult {
  /** awal minggu yang dibekukan (YYYY-MM-DD, Senin WIB) */
  weekStart: string
  /** juara baru yang dicatat (0 = minggu itu sudah dibekukan sebelumnya atau tak ada XP) */
  inserted: number
  /** push terkirim pada putaran ini */
  notified: number
}

const TICK_MS = 10 * 60_000
const FIRST_TICK_MS = 30_000
/** Push yang gagal dicoba lagi sampai sejauh ini sejak juara dicatat; lewat itu dianggap basi. */
const RETRY_WINDOW = '3 days'

const INSERT_SQL = `
INSERT INTO weekly_winners (week_start, rank, user_id, week_xp)
SELECT $1::date, r.rank, r.user_id, r.wxp
  FROM (
    SELECT w.user_id, w.wxp, row_number() OVER (ORDER BY w.wxp DESC, w.last_at ASC, w.user_id ASC)::int AS rank
      FROM (
        SELECT e.user_id, sum(e.xp)::int AS wxp, max(e.created_at) AS last_at
          FROM xp_events e WHERE e.day >= $1::date AND e.day < $2::date GROUP BY e.user_id
      ) w JOIN users u ON u.id = w.user_id WHERE u.banned_at IS NULL
  ) r
 WHERE r.rank <= 3
ON CONFLICT DO NOTHING`

/**
 * Juara papan XP mingguan. Tiap minggu baru (Senin 00.00 WIB) tiga teratas minggu sebelumnya dibekukan ke `weekly_winners`
 * (aturan urutan sama dengan papan: XP terbanyak, seri = yang lebih dulu mencapainya, akun diblokir tidak ikut), lalu tiap juara
 * dikirimi push sekali. Aman dipanggil berulang: baris yang sudah ada tidak dicatat ulang dan push yang sudah terkirim tidak diulang.
 */
export class WeeklyChampions {
  private timer?: NodeJS.Timeout
  private first?: NodeJS.Timeout
  private running = false
  private doneWeek = ''

  constructor(
    private readonly pool: Pool,
    private readonly log: FastifyBaseLogger,
    private readonly push?: ChampionNotifier
  ) {}

  start(): void {
    if (this.timer) return
    this.first = setTimeout(() => void this.tick(), FIRST_TICK_MS)
    this.first.unref()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    clearTimeout(this.first)
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    try {
      await this.finalize()
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'weekly champions failed')
    }
  }

  async finalize(now = Date.now()): Promise<FinalizeResult> {
    if (this.running) return { weekStart: '', inserted: 0, notified: 0 }
    this.running = true
    try {
      const current = weekWindow(now)
      const prev = weekWindow(current.startAt - 1) // 1 ms sebelum Senin 00.00 WIB = minggu yang baru selesai
      let inserted = 0
      if (this.doneWeek !== prev.startDay) {
        const res = await this.pool.query(INSERT_SQL, [prev.startDay, current.startDay])
        inserted = res.rowCount ?? res.rows?.length ?? 0
        this.doneWeek = prev.startDay
        if (inserted) this.log.info({ week: prev.startDay, inserted }, 'weekly champions recorded')
      }
      const notified = await this.notifyPending()
      return { weekStart: prev.startDay, inserted, notified }
    } finally {
      this.running = false
    }
  }

  private async notifyPending(): Promise<number> {
    if (!this.push?.configured) return 0
    const { rows } = await this.pool.query(
      `SELECT week_start, rank, user_id, week_xp FROM weekly_winners
        WHERE notified_at IS NULL AND created_at > now() - interval '${RETRY_WINDOW}'
        ORDER BY week_start, rank`
    )
    let sent = 0
    for (const r of rows) {
      let ok = false
      try {
        ok = await this.push.champion(Number(r.user_id), Number(r.rank), Number(r.week_xp))
      } catch (e) {
        this.log.warn({ user: r.user_id, err: (e as Error).message }, 'champion push failed')
      }
      if (!ok) continue // push dimatikan / gagal: coba lagi di putaran berikut (selama masih dalam jendela)
      sent++
      await this.pool
        .query('UPDATE weekly_winners SET notified_at = now() WHERE week_start = $1 AND rank = $2', [r.week_start, r.rank])
        .catch(() => undefined)
    }
    return sent
  }

  /** Riwayat juara satu pengguna (publik). */
  async history(userId: number): Promise<ChampionHistory> {
    const [counts, recent] = await Promise.all([
      this.pool.query('SELECT rank, count(*)::int AS n FROM weekly_winners WHERE user_id = $1 GROUP BY rank', [userId]),
      this.pool.query(
        `SELECT to_char(week_start, 'YYYY-MM-DD') AS ws, rank, week_xp FROM weekly_winners WHERE user_id = $1 ORDER BY week_start DESC LIMIT 8`,
        [userId]
      )
    ])
    const n = (rank: number) => Number(counts.rows.find((r: { rank: unknown }) => Number(r.rank) === rank)?.n ?? 0)
    return {
      first: n(1),
      second: n(2),
      third: n(3),
      recent: recent.rows.map((r: { ws: string; rank: unknown; week_xp: unknown }) => ({
        weekStart: Date.parse(`${r.ws}T00:00:00+07:00`),
        rank: Number(r.rank),
        weekXp: Number(r.week_xp)
      }))
    }
  }
}

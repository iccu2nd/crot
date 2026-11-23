/** Aturan XP & kurva level (murni, mudah diuji). */

export const XP_RULES = {
  /** membaca chapter (sekali per chapter) */
  read: { xp: 10, perDay: 20 },
  /** komentar atau balasan */
  comment: { xp: 5, perDay: 10 },
  /** menambah seri ke pustaka (sekali per seri) */
  bookmark: { xp: 3, perDay: 5 },
  /** membuka aplikasi (sekali per hari) */
  daily: { xp: 5, perDay: 1 },
  /** komentarmu disukai orang lain (sekali per penyuka) */
  liked: { xp: 1, perDay: 20 }
} as const
export type XpKind = keyof typeof XP_RULES
/** Jenis yang boleh dilaporkan app lewat POST /xp/event (komentar & like dihitung server sendiri). */
export const CLIENT_KINDS = ['read', 'bookmark', 'daily'] as const

/**
 * XP yang dibutuhkan untuk naik dari level L ke L+1. Awal-awal murah, makin tinggi makin mahal:
 * L1→2: 40 · L5→6: 116 · L10→11: 256 · L20→21: 686 · L50→51: 3.176.
 */
export const levelCost = (level: number): number => 40 + 15 * (level - 1) + (level - 1) ** 2

interface LevelInfo {
  level: number
  /** XP yang sudah terkumpul di level ini */
  into: number
  /** XP yang dibutuhkan untuk naik dari level ini */
  need: number
}

export function levelFor(xp: number): LevelInfo {
  let level = 1
  let left = Math.max(0, Math.floor(Number(xp) || 0))
  while (left >= levelCost(level) && level < 10000) {
    left -= levelCost(level)
    level++
  }
  return { level, into: left, need: levelCost(level) }
}

const WIB_MS = 7 * 3600_000
const DAY_MS = 86_400_000

interface WeekWindow {
  /** Tanggal Senin minggu ini (WIB), "YYYY-MM-DD" — cocok dengan kolom xp_events.day */
  startDay: string
  /** Awal minggu (Senin 00.00 WIB), epoch ms */
  startAt: number
  /** Awal minggu berikutnya = waktu reset papan peringkat, epoch ms */
  endAt: number
}

/** Jendela papan peringkat mingguan: Senin 00.00 WIB sampai Senin berikutnya (murni, mudah diuji). */
export function weekWindow(now = Date.now()): WeekWindow {
  const wall = now + WIB_MS // "jam dinding" WIB dibaca sebagai UTC
  const dayStart = Math.floor(wall / DAY_MS) * DAY_MS
  const sinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7 // Senin = 0
  const start = dayStart - sinceMonday * DAY_MS
  return { startDay: new Date(start).toISOString().slice(0, 10), startAt: start - WIB_MS, endAt: start + 7 * DAY_MS - WIB_MS }
}

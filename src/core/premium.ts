/** Aturan fitur Premium (murni, mudah diuji). */

/** Pengali bonus XP untuk Premium (dibulatkan ke atas per perolehan). */
export const PREMIUM_XP_MULT = 1.5
export const premiumXp = (base: number): number => Math.ceil(base * PREMIUM_XP_MULT)

/** Id tema profil & frame avatar yang valid (tampilannya digambar di app). */
export const THEMES = ['ocean', 'sakura', 'aurora', 'sunset', 'gold', 'violet'] as const
export const FRAMES = ['gold', 'neon', 'sakura', 'flame', 'ice', 'emerald'] as const

export const MAX_GIF_AVATAR_BYTES = 2 * 1024 * 1024
export const MAX_HEADER_BYTES = 450 * 1024
export const MAX_HEADER_BLUR = 25

/** Fragmen SQL "Premium sedang aktif" untuk tabel users (alias opsional): flag permanen ATAU langganan belum habis. */
export const isPremiumSql = (alias = ''): string => {
  const p = alias ? `${alias}.` : ''
  return `(${p}premium OR (${p}premium_until IS NOT NULL AND ${p}premium_until > now()))`
}

export const isGif = (b: unknown): b is Buffer =>
  Buffer.isBuffer(b) && b.length > 10 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')

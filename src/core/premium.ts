/** Aturan fitur Premium (murni, mudah diuji). */

/** Pengali bonus XP untuk Premium (dibulatkan ke atas per perolehan). */
export const PREMIUM_XP_MULT = 1.5
export const premiumXp = (base: number): number => Math.ceil(base * PREMIUM_XP_MULT)

/** Id tema profil & frame avatar yang valid (tampilannya digambar di app). */
export const THEMES = ['ocean', 'sakura', 'aurora', 'sunset', 'gold', 'violet'] as const
export const FRAMES = ['gold', 'neon', 'sakura', 'flame', 'ice', 'emerald'] as const

/** Fragmen SQL "Premium sedang aktif" untuk tabel users (alias opsional): flag permanen ATAU langganan belum habis. */
export const isPremiumSql = (alias = ''): string => {
  const p = alias ? `${alias}.` : ''
  return `(${p}premium OR (${p}premium_until IS NOT NULL AND ${p}premium_until > now()))`
}

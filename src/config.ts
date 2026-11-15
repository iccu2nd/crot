import { PROVIDER_KEYS } from './core/types.js'

const env = process.env
const min = (n: number) => n * 60_000
const hour = (n: number) => n * 3_600_000

/** true di Vercel (VERCEL=1 otomatis): tanpa timer latar, tulis DB inline, tanpa migrate saat runtime */
const serverless = env.VERCEL === '1'

/** Hanya DATABASE_URL & REDIS_URL yang wajib diisi; ADMIN_TOKEN opsional (mengaktifkan endpoint admin pengumuman). */
export const config = {
  serverless,
  port: Number(env.PORT) || 3000,
  host: '0.0.0.0',
  logLevel: 'info',
  trustProxy: true,
  databaseUrl: env.DATABASE_URL ?? 'postgres://scraper:scraper@localhost:5432/scraper',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  adminToken: env.ADMIN_TOKEN ?? '',
  pgPoolMax: serverless ? 2 : 10,
  autoMigrate: !serverless,
  providers: [...PROVIDER_KEYS].sort((a, b) => ['shinigami', 'manta', 'lumos'].indexOf(a) - ['shinigami', 'manta', 'lumos'].indexOf(b)),
  rateLimitMax: 120,
  aggregateTimeoutMs: 8000,
  /** Daftar (latest/search): setelah provider PERTAMA menjawab dengan data, provider lain yang lambat hanya ditunggu sebatas ini (ms). 0 = tunggu semua. */
  listGraceMs: 2500,
  /** Saat satu chapter dibuka, chapter berikutnya diambil lebih dulu di background (baca lanjut = instan). */
  prefetchNextChapter: true,
  primaryTimeoutMs: 12000,
  warmer: { enabled: true, intervalMs: 600_000, enrich: 5 },
  /** fresh = dilayani langsung, stale = dilayani + refresh background / saat upstream gagal */
  ttl: {
    search: { fresh: min(5), stale: hour(1) },
    latest: { fresh: min(2), stale: hour(1) },
    detail: { fresh: min(15), stale: hour(24) },
    chapter: { fresh: min(10), stale: hour(1) },
    db: { fresh: min(1), stale: min(10) },
    genres: { fresh: min(10), stale: hour(1) }
  }
}
export type Config = typeof config

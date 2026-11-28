import type { FastifyPluginAsync } from 'fastify'
import { UnauthorizedError } from '../core/errors.js'
import type { WeeklyChampions } from '../services/champions.js'
import { tokenMatches } from './announcements.js'

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } })

export const championRoutes: FastifyPluginAsync<{ champions: WeeklyChampions; cronSecret?: string }> = async (app, { champions, cronSecret = '' }) => {
  // Publik: berapa kali & kapan seorang pengguna menjadi juara 1-3 papan XP mingguan.
  app.get<{ Params: { id: number } }>(
    '/users/:id/champions',
    {
      schema: { tags: ['xp'], summary: 'Riwayat juara papan XP mingguan', params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } },
      config: limit(120)
    },
    async (req, reply) => {
      reply.headers({ 'cache-control': 'public, max-age=60' })
      return { data: await champions.history(req.params.id) }
    }
  )

  // Untuk mode serverless (tanpa timer latar): panggil berkala dari cron, mis. tiap 10-15 menit.
  app.get('/internal/champions/cron', { config: limit(5), schema: { hide: true } }, async req => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!cronSecret || !tokenMatches(bearer, cronSecret)) throw new UnauthorizedError('Cron secret tidak valid')
    return { data: await champions.finalize() }
  })
}

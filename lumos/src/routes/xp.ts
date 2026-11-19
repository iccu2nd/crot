import type { FastifyPluginAsync } from 'fastify'
import type { AuthService } from '../services/auth.js'
import type { XpService } from '../services/xp.js'

export const xpRoutes: FastifyPluginAsync<{ auth: AuthService; xp: XpService }> = async (app, { auth, xp }) => {
  app.post(
    '/xp/event',
    {
      schema: {
        tags: ['auth'],
        summary: 'Laporkan aktivitas untuk XP (read = chapter, bookmark = seri, daily = buka app)',
        description: 'Tiap chapter/seri hanya dihitung sekali dan ada batas harian per jenis. Komentar & like dihitung server sendiri.',
        body: { type: 'object', required: ['type'], properties: { type: { type: 'string', maxLength: 20 }, ref: { type: ['string', 'null'], maxLength: 330 } } }
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    },
    async (req, reply) => {
      const me = await auth.me(req.headers.authorization)
      const b = req.body as { type: string; ref?: string | null }
      const gained = await xp.report(me.id, b.type, b.ref)
      void reply.header('cache-control', 'no-store')
      return { data: { gained, user: gained ? await auth.me(req.headers.authorization) : me } }
    }
  )
}

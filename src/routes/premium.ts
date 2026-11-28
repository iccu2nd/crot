import type { FastifyPluginAsync } from 'fastify'
import type { AuthService } from '../services/auth.js'
import type { PremiumService, StylePatch } from '../services/premium.js'

const noStore = { 'cache-control': 'no-store' }

export const premiumRoutes: FastifyPluginAsync<{ auth: AuthService; premium: PremiumService }> = async (app, { auth, premium }) => {
  app.patch(
    '/auth/me/style',
    {
      schema: {
        tags: ['premium'],
        summary: 'Tema dan frame avatar ("" = bawaan). Mengubah ke nilai baru khusus Premium.',
        body: {
          type: 'object',
          properties: { theme: { type: ['string', 'null'], maxLength: 20 }, frame: { type: ['string', 'null'], maxLength: 20 } }
        }
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    },
    async (req, reply) => {
      const me = await auth.me(req.headers.authorization)
      await premium.setStyle(me.id, me.premium, (req.body ?? {}) as StylePatch)
      void reply.headers(noStore)
      return { data: await auth.me(req.headers.authorization) }
    }
  )
}

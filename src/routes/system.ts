import type { FastifyPluginAsync } from 'fastify'
import type { Redis } from 'ioredis'
import type { Store } from '../core/types.js'
import type { StorageGuard } from '../services/storage/policy.js'

export const systemRoutes: FastifyPluginAsync<{ store: Store; redis: Redis | null; storage?: StorageGuard }> = async (app, { store, redis, storage }) => {
  app.get(
    '/health',
    {
      schema: { tags: ['system'], summary: 'Health check (PostgreSQL & Redis)' },
      config: { rateLimit: false }
    },
    async () => {
      const [db, cache] = await Promise.all([
        store.ping(),
        redis ? redis.ping().then(() => true, () => false) : Promise.resolve(false)
      ])
      const level = storage ? (await storage.policy().catch(() => undefined))?.level ?? 'ok' : 'ok'
      return { status: db && cache && level !== 'critical' ? 'ok' : 'degraded', db, cache, storage: level }
    }
  )
}

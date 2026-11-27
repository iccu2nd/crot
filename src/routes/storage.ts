import type { FastifyPluginAsync } from 'fastify'
import { AppError, UnauthorizedError, ValidationError } from '../core/errors.js'
import type { AuthService } from '../services/auth.js'
import type { StorageManager } from '../services/storage/manager.js'
import { isBackupName } from '../services/storage/backup.js'
import { tokenMatches } from './announcements.js'

const strict = { rateLimit: { max: 30, timeWindow: '1 minute' } }
const heavy = { rateLimit: { max: 5, timeWindow: '1 minute' } }

export const storageRoutes: FastifyPluginAsync<{
  auth: AuthService
  storage: StorageManager
  adminToken?: string
  cronSecret?: string
}> = async (app, { auth, storage, adminToken = '', cronSecret = '' }) => {
  const guard = async (req: { headers: { authorization?: string; 'x-admin-token'?: unknown } }) => {
    if (adminToken && tokenMatches(req.headers['x-admin-token'], adminToken)) return
    await auth.requireOwner(req.headers.authorization)
  }

  app.get('/admin/storage', { onRequest: guard, config: strict, schema: { hide: true } }, async () => ({ data: await storage.status() }))

  app.get<{ Querystring: { limit?: number; kind?: string } }>(
    '/admin/storage/events',
    {
      onRequest: guard,
      config: strict,
      schema: {
        hide: true,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, kind: { type: 'string', maxLength: 20 } }
        }
      }
    },
    async req => ({ data: await storage.events(req.query.limit ?? 50, req.query.kind) })
  )

  app.post<{ Body: { mode?: 'auto' | 'aggressive' } | undefined }>(
    '/admin/storage/maintain',
    {
      onRequest: guard,
      config: heavy,
      schema: { hide: true, body: { type: ['object', 'null'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['auto', 'aggressive'] } } } }
    },
    async req => ({ data: await storage.maintain(req.body?.mode ?? 'auto') })
  )

  app.get('/admin/storage/backups', { onRequest: guard, config: strict, schema: { hide: true } }, async () => ({
    data: { items: await storage.backups.list() }
  }))

  app.post('/admin/storage/backups', { onRequest: guard, config: heavy, schema: { hide: true } }, async (_req, reply) =>
    reply.code(201).send({ data: await storage.backup() })
  )

  app.get<{ Params: { name: string } }>(
    '/admin/storage/backups/:name',
    { onRequest: guard, config: heavy, schema: { hide: true, params: { type: 'object', properties: { name: { type: 'string', maxLength: 80 } }, required: ['name'] } } },
    async (req, reply) => {
      if (!isBackupName(req.params.name)) throw new ValidationError('Nama backup tidak valid')
      const exists = (await storage.backups.list()).some(b => b.name === req.params.name)
      if (!exists) throw new AppError(404, 'NOT_FOUND', 'Backup tidak ditemukan')
      return reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="${req.params.name}"`)
        .header('cache-control', 'no-store')
        .send(storage.backups.openStream(req.params.name))
    }
  )

  app.get('/admin/storage/export', { onRequest: guard, config: heavy, schema: { hide: true } }, async (_req, reply) => {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="mitoon-${stamp}.ndjson.gz"`)
      .header('cache-control', 'no-store')
      .send(await storage.exportStream())
  })

  app.get('/internal/storage/cron', { config: heavy, schema: { hide: true } }, async req => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!cronSecret || !tokenMatches(bearer, cronSecret)) throw new UnauthorizedError('Cron secret tidak valid')
    return { data: await storage.maintain('auto') }
  })
}

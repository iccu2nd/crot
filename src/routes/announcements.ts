import { timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { NotFoundError, UnauthorizedError, ValidationError } from '../core/errors.js'
import type { AnnouncementRepo } from '../services/announcements.js'
import { envelope } from './schemas.js'

const publicCache = (seconds: number) => ({ 'cache-control': `public, max-age=${seconds}` })

/** Perbandingan token waktu-konstan. Token kosong di konfigurasi = admin nonaktif = selalu false. */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const item = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    title: { type: 'string' },
    body: { type: 'string' },
    url: { type: 'string', nullable: true }
  }
} as const

export const announcementRoutes: FastifyPluginAsync<{ repo: AnnouncementRepo; adminToken: string }> = async (
  app,
  { repo, adminToken }
) => {
  app.get(
    '/announcements',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Pengumuman untuk aplikasi',
        description: 'Pengumuman aktif (maks. 5, terbaru dulu). Aplikasi menyembunyikan bagian ini jika kosong.',
        response: { 200: envelope({ type: 'array', items: item }) }
      }
    },
    async (_req, reply) => reply.headers(publicCache(60)).send({ data: await repo.active(5) })
  )

  // Endpoint admin hanya ada jika ADMIN_TOKEN diisi.
  if (!adminToken) return
  const guard = async (req: { headers: Record<string, unknown> }) => {
    if (!tokenMatches(req.headers['x-admin-token'], adminToken)) throw new UnauthorizedError()
  }
  const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } }

  app.post<{ Body: { title: string; body?: string; url?: string; expiresAt?: string } }>(
    '/admin/announcements',
    {
      onRequest: guard,
      config: strict,
      schema: {
        hide: true,
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 120 },
            body: { type: 'string', maxLength: 500 },
            url: { type: 'string', maxLength: 500, pattern: '^https?://' },
            expiresAt: { type: 'string', maxLength: 40 }
          }
        }
      }
    },
    async (req, reply) => {
      const { title, body, url, expiresAt } = req.body
      if (!title.trim()) throw new ValidationError('title tidak boleh kosong')
      if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) throw new ValidationError('expiresAt harus tanggal ISO-8601')
      return reply.code(201).send({ data: await repo.create({ title, body, url, expiresAt }) })
    }
  )

  app.delete<{ Params: { id: number } }>(
    '/admin/announcements/:id',
    {
      onRequest: guard,
      config: strict,
      schema: { hide: true, params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } }
    },
    async req => {
      if (!(await repo.remove(req.params.id))) throw new NotFoundError('Pengumuman tidak ditemukan')
      return { data: { deleted: true } }
    }
  )
}

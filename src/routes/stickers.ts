import type { FastifyPluginAsync } from 'fastify'
import { USER_CONTENT_CSP } from '../core/security.js'
import { AppError, NotFoundError } from '../core/errors.js'
import type { AuthService } from '../services/auth.js'
import { MAX_STICKER_BYTES, type StickerService } from '../services/stickers.js'

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } })
const idParams = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } as const

export const stickerRoutes: FastifyPluginAsync<{ auth: AuthService; stickers: StickerService }> = async (app, { auth, stickers }) => {
  for (const type of ['image/png', 'image/webp', 'image/jpeg', 'image/gif'])
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_STICKER_BYTES }, (_req, body, done) => done(null, body))

  app.get('/stickers/global', { schema: { tags: ['stickers'], summary: 'Stiker global (ditambahkan admin)' }, config: limit(120) }, async (_req, reply) => {
    void reply.header('cache-control', 'no-store')
    return { data: await stickers.list(null) }
  })

  app.get('/stickers/mine', { schema: { tags: ['stickers'], summary: 'Stikerku — wajib login' }, config: limit(120) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    void reply.header('cache-control', 'no-store')
    return { data: await stickers.list(user.id) }
  })

  app.post('/stickers/mine', { schema: { tags: ['stickers'], summary: 'Tambah stiker sendiri (body = gambar PNG/WebP/JPEG/GIF maks. 400 KB) — khusus Premium' }, config: limit(20) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    if (!user.premium) throw new AppError(403, 'PREMIUM_REQUIRED', 'Menambah stiker sendiri khusus Premium')
    void reply.header('cache-control', 'no-store')
    return { data: await stickers.add(user.id, req.body) }
  })

  app.delete('/stickers/mine/:id', { schema: { tags: ['stickers'], summary: 'Hapus stiker sendiri', params: idParams }, config: limit(60) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    await stickers.remove((req.params as { id: number }).id, user.id)
    void reply.header('cache-control', 'no-store')
    return { data: { ok: true } }
  })

  app.get('/stickers/:id/image', { schema: { tags: ['stickers'], summary: 'Gambar stiker', params: idParams }, config: limit(600) }, async (req, reply) => {
    const img = await stickers.image((req.params as { id: number }).id)
    if (!img) throw new NotFoundError('Stiker tidak ada')
    return reply
      .header('content-type', img.mime)
      .header('content-security-policy', USER_CONTENT_CSP)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(img.data)
  })

  app.post('/admin/stickers', { schema: { hide: true }, config: limit(60) }, async (req, reply) => {
    await auth.requireOwner(req.headers.authorization)
    void reply.header('cache-control', 'no-store')
    return { data: await stickers.add(null, req.body) }
  })

  app.delete('/admin/stickers/:id', { schema: { hide: true, params: idParams }, config: limit(60) }, async (req, reply) => {
    await auth.requireOwner(req.headers.authorization)
    await stickers.remove((req.params as { id: number }).id, null)
    void reply.header('cache-control', 'no-store')
    return { data: { ok: true } }
  })
}

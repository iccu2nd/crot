import type { FastifyPluginAsync } from 'fastify'
import type { AuthService } from '../services/auth.js'
import type { CommentService } from '../services/comments.js'

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } })

export const commentRoutes: FastifyPluginAsync<{ auth: AuthService; comments: CommentService }> = async (app, { auth, comments }) => {
  app.get(
    '/comments',
    {
      schema: {
        tags: ['comments'],
        summary: 'Komentar sebuah seri/chapter (terbaru dulu)',
        description: '`target` = `s:<id seri>` atau `c:<id chapter>`. Paginasi: kirim `before` = id komentar terakhir yang sudah dimuat.',
        querystring: {
          type: 'object',
          required: ['target'],
          properties: { target: { type: 'string', maxLength: 330 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, before: { type: 'integer', minimum: 1 } }
        }
      },
      config: limit(90)
    },
    async (req, reply) => {
      const q = req.query as { target: string; limit?: number; before?: number }
      void reply.header('cache-control', 'no-store')
      return { data: await comments.list(q.target, q.limit ?? 20, q.before, auth.viewerId(req.headers.authorization)) }
    }
  )

  app.get(
    '/comments/:id/replies',
    {
      schema: {
        tags: ['comments'],
        summary: 'Balasan sebuah komentar (lama → baru)',
        description: 'Paginasi: kirim `after` = id balasan terakhir yang sudah dimuat.',
        params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } },
        querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, after: { type: 'integer', minimum: 0 } } }
      },
      config: limit(90)
    },
    async (req, reply) => {
      const q = req.query as { limit?: number; after?: number }
      void reply.header('cache-control', 'no-store')
      return { data: await comments.replies((req.params as { id: number }).id, q.limit ?? 20, q.after ?? 0, auth.viewerId(req.headers.authorization)) }
    }
  )

  app.put(
    '/comments/:id/vote',
    {
      schema: {
        tags: ['comments'],
        summary: 'Like (1), dislike (-1), atau batalkan (0) — wajib login',
        params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } },
        body: { type: 'object', required: ['value'], properties: { value: { type: 'integer', minimum: -1, maximum: 1 } } }
      },
      config: limit(60)
    },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      void reply.header('cache-control', 'no-store')
      return { data: await comments.vote(user.id, (req.params as { id: number }).id, (req.body as { value: number }).value) }
    }
  )

  app.post(
    '/comments',
    {
      schema: { tags: ['comments'], summary: 'Kirim komentar atau balasan (`parentId` = id komentar yang dibalas) — wajib login', body: { type: 'object', required: ['target', 'body'], properties: { target: { type: 'string', maxLength: 330 }, body: { type: 'string', maxLength: 4000 }, parentId: { type: ['integer', 'null'], minimum: 1 } } } },
      config: limit(10)
    },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      const b = req.body as { target: string; body: string; parentId?: number | null }
      const item = await comments.add(user.id, b.target, b.body, b.parentId)
      void reply.header('cache-control', 'no-store')
      // `me` = akun terbaru (XP/level setelah komentar) supaya app tak perlu request tambahan
      return { data: item, me: await auth.me(req.headers.authorization) }
    }
  )

  app.delete(
    '/comments/:id',
    { schema: { tags: ['comments'], summary: 'Hapus komentar sendiri', params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } }, config: limit(30) },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      await comments.remove(user.id, (req.params as { id: number }).id)
      void reply.header('cache-control', 'no-store')
      return { data: { ok: true } }
    }
  )
}

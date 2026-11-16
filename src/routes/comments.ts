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
      return { data: await comments.list(q.target, q.limit ?? 20, q.before) }
    }
  )

  app.post(
    '/comments',
    {
      schema: { tags: ['comments'], summary: 'Kirim komentar (wajib login)', body: { type: 'object', required: ['target', 'body'], properties: { target: { type: 'string', maxLength: 330 }, body: { type: 'string', maxLength: 4000 } } } },
      config: limit(10)
    },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      const b = req.body as { target: string; body: string }
      void reply.header('cache-control', 'no-store')
      return { data: await comments.add(user.id, b.target, b.body) }
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

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
      const authHeader = req.headers.authorization; const viewer = authHeader ? await auth.me(authHeader).catch(() => null) : null
      void reply.header('cache-control', 'no-store')
      return { data: await comments.list(q.target, q.limit ?? 20, q.before, viewer?.id ?? null) }
    }
  )

  app.post(
    '/comments',
    {
      schema: { tags: ['comments'], summary: 'Kirim komentar (wajib login)', body: { type: 'object', required: ['target', 'body'], properties: { target: { type: 'string', maxLength: 330 }, body: { type: 'string', maxLength: 4000 }, parentId: { type: 'integer', minimum: 1 } } } },
      config: limit(10)
    },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      const b = req.body as { target: string; body: string; parentId?: number }
      const item = await comments.add(user.id, b.target, b.body, b.parentId)
      await auth.awardXp(user.id, `comment:${item.id}`, b.parentId ? 4 : 8)
      void reply.header('cache-control', 'no-store')
      return { data: item }
    }
  )

  app.post('/comments/:id/reaction', { schema: { tags: ['comments'], summary: 'Like/dislike komentar', body: { type: 'object', required: ['kind'], properties: { kind: { type: ['string','null'], enum: ['like','dislike',null] } } } }, config: limit(60) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization); const id = Number((req.params as {id:string}).id); const b = req.body as {kind:'like'|'dislike'|null}
    const data = await comments.react(user.id,id,b.kind); void reply.header('cache-control','no-store'); return {data}
  })

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

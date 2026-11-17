import type { FastifyPluginAsync } from 'fastify'
import type { AuthService } from '../services/auth.js'
import type { NotificationService } from '../services/notifications.js'

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } })

/** Notifikasi akun (wajib login). Pengumuman admin (tab Informasi) memakai GET /announcements. */
export const notificationRoutes: FastifyPluginAsync<{ auth: AuthService; notifications: NotificationService }> = async (app, { auth, notifications }) => {
  app.get(
    '/notifications',
    {
      schema: { tags: ['auth'], summary: 'Notifikasi: balasan & like pada komentarmu (terbaru dulu, maks. 50)' },
      config: limit(60)
    },
    async (req, reply) => {
      const me = await auth.me(req.headers.authorization)
      void reply.header('cache-control', 'no-store')
      return { data: await notifications.list(me.id) }
    }
  )

  app.get(
    '/notifications/unread',
    {
      schema: { tags: ['auth'], summary: 'Jumlah notifikasi + pengumuman yang belum dibaca (untuk pil merah)' },
      config: limit(120)
    },
    async (req, reply) => {
      const me = await auth.me(req.headers.authorization)
      void reply.header('cache-control', 'no-store')
      return { data: { count: await notifications.unreadCount(me.id) } }
    }
  )

  app.post(
    '/notifications/read',
    {
      schema: { tags: ['auth'], summary: 'Tandai semua notifikasi & pengumuman sudah dibaca' },
      config: limit(60)
    },
    async (req, reply) => {
      const me = await auth.me(req.headers.authorization)
      await notifications.markRead(me.id)
      void reply.header('cache-control', 'no-store')
      return { data: { ok: true } }
    }
  )
}

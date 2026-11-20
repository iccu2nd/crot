import type { FastifyPluginAsync } from 'fastify'
import { MAX_AVATAR_BYTES, MAX_BANNER_BYTES, isJpeg } from '../core/comments.js'
import { NotFoundError, ValidationError } from '../core/errors.js'
import type { AuthService } from '../services/auth.js'

const noStore = { 'cache-control': 'no-store' }
const str = (max: number) => ({ type: 'string', maxLength: max }) as const
const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } })

export const authRoutes: FastifyPluginAsync<{ auth: AuthService }> = async (app, { auth }) => {
  const reply200 = (reply: { headers: (h: Record<string, string>) => unknown }) => reply.headers(noStore)

  app.get('/auth/config', { schema: { tags: ['auth'], summary: 'Metode login yang aktif (untuk tampilan app)' } }, async (_req, reply) => {
    reply200(reply)
    return { data: { google: auth.googleClientId } }
  })

  app.post(
    '/auth/register',
    { schema: { tags: ['auth'], summary: 'Daftar akun', body: { type: 'object', required: ['username', 'email', 'password'], properties: { username: str(40), email: str(300), password: str(200) } } }, config: limit(5) },
    async (req, reply) => {
      const b = req.body as { username: string; email: string; password: string }
      reply200(reply)
      return { data: await auth.register(b.username, b.email, b.password) }
    }
  )

  app.post(
    '/auth/login',
    { schema: { tags: ['auth'], summary: 'Masuk dengan username/email + password', body: { type: 'object', required: ['identifier', 'password'], properties: { identifier: str(300), password: str(200) } } }, config: limit(10) },
    async (req, reply) => {
      const b = req.body as { identifier: string; password: string }
      reply200(reply)
      return { data: await auth.login(b.identifier, b.password) }
    }
  )

  app.post(
    '/auth/google',
    { schema: { tags: ['auth'], summary: 'Masuk dengan Google (ID token dari app)', body: { type: 'object', required: ['idToken'], properties: { idToken: str(4096) } } }, config: limit(10) },
    async (req, reply) => {
      reply200(reply)
      return { data: await auth.google((req.body as { idToken: string }).idToken) }
    }
  )

  // ---- foto profil: JPEG mentah (app sudah memotong persegi & mengecilkan ke ±384px) ----
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_BANNER_BYTES }, (_req, body, done) => done(null, body))

  app.put('/auth/me/avatar', { schema: { tags: ['auth'], summary: 'Ganti foto profil (body = image/jpeg, maks. 300 KB)' }, config: limit(10) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    const body = req.body
    if (!isJpeg(body)) throw new ValidationError('Foto harus berformat JPEG')
    if (body.length > MAX_AVATAR_BYTES) throw new ValidationError('Foto terlalu besar (maks. 300 KB)')
    reply200(reply)
    return { data: await auth.setAvatar(user.id, body) }
  })

  app.delete('/auth/me/avatar', { schema: { tags: ['auth'], summary: 'Hapus foto profil' }, config: limit(10) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    reply200(reply)
    return { data: await auth.clearAvatar(user.id) }
  })

  app.put('/auth/me/banner', { schema: { tags: ['auth'], summary: 'Ganti background profil (body = image/jpeg, maks. 700 KB)' }, config: limit(10) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    const body = req.body
    if (!isJpeg(body)) throw new ValidationError('Gambar harus berformat JPEG')
    if (body.length > MAX_BANNER_BYTES) throw new ValidationError('Gambar terlalu besar (maks. 700 KB)')
    reply200(reply)
    return { data: await auth.setBanner(user.id, body) }
  })

  app.delete('/auth/me/banner', { schema: { tags: ['auth'], summary: 'Hapus background profil' }, config: limit(10) }, async (req, reply) => {
    const user = await auth.me(req.headers.authorization)
    reply200(reply)
    return { data: await auth.clearBanner(user.id) }
  })

  app.get(
    '/users/:id/banner',
    { schema: { tags: ['auth'], summary: 'Background profil pengguna', params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } }, config: limit(300) },
    async (req, reply) => {
      const buf = await auth.bannerOf((req.params as { id: number }).id)
      if (!buf) throw new NotFoundError('Belum ada background profil')
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(buf)
    }
  )

  // Publik (dipakai Coil/gambar): URL memuat ?v=<avatarV> sehingga aman di-cache lama.
  app.get(
    '/users/:id/avatar',
    { schema: { tags: ['auth'], summary: 'Foto profil pengguna', params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } }, config: limit(300) },
    async (req, reply) => {
      const buf = await auth.avatarOf((req.params as { id: number }).id)
      if (!buf) throw new NotFoundError('Belum ada foto profil')
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(buf)
    }
  )

  // Publik: profil singkat pengguna lain (nama, level, XP, kapan bergabung, jumlah komentar).
  app.get(
    '/users/:id',
    { schema: { tags: ['auth'], summary: 'Profil publik pengguna', params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } }, config: limit(120) },
    async (req, reply) => {
      reply.headers({ 'cache-control': 'public, max-age=30' })
      return { data: await auth.publicProfile((req.params as { id: number }).id) }
    }
  )

  app.patch(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Ubah nama tampilan, bio, dan/atau username (username: cooldown 7 hari)',
        body: { type: 'object', properties: { displayName: { type: ['string', 'null'], maxLength: 200 }, username: { type: ['string', 'null'], maxLength: 60 }, bio: { type: ['string', 'null'], maxLength: 600 }, verifiedHidden: { type: 'boolean' } } }
      },
      config: limit(10)
    },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      const b = (req.body ?? {}) as { displayName?: string | null; username?: string | null; bio?: string | null; verifiedHidden?: boolean }
      reply200(reply)
      return { data: await auth.updateProfile(user.id, b) }
    }
  )

  app.delete(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Hapus akun permanen (wajib `confirm=HAPUS`)',
        querystring: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string', maxLength: 20 } } }
      },
      config: limit(3)
    },
    async (req, reply) => {
      const user = await auth.me(req.headers.authorization)
      if ((req.query as { confirm: string }).confirm !== 'HAPUS') throw new ValidationError('Ketik HAPUS untuk mengonfirmasi')
      await auth.deleteAccount(user.id)
      reply200(reply)
      return { data: { ok: true } }
    }
  )

  app.get('/auth/me', { schema: { tags: ['auth'], summary: 'Akun yang sedang masuk (Bearer token)' }, config: limit(60) }, async (req, reply) => {
    reply200(reply)
    return { data: await auth.me(req.headers.authorization) }
  })
}

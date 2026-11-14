// Entry serverless Vercel: membangun app Fastify sekali per instance lalu meneruskan request.
import { createApp } from '../dist/app.js'
import { config } from '../dist/config.js'

let ready
export default async function handler(req, res) {
  ready ??= createApp(config)
    .then(async app => (await app.ready(), app))
    .catch(err => {
      ready = undefined // coba lagi pada request berikutnya
      throw err
    })
  const app = await ready
  app.server.emit('request', req, res)
}

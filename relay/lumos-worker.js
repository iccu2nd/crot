// Cloudflare Worker: relay GET ke Lumos supaya tidak diblokir (403) dari IP Vercel.
// Deploy: dash.cloudflare.com -> Workers -> Create -> paste file ini.
// Settings -> Variables: KEY = <string rahasia> (samakan dengan LUMOS_RELAY_KEY di Vercel).
export default {
  async fetch(req, env) {
    if (env.KEY && req.headers.get('x-relay-key') !== env.KEY) return new Response('forbidden', { status: 403 })
    const target = new URL(req.url).searchParams.get('url')
    if (!target) return new Response('missing url', { status: 400 })
    let t
    try { t = new URL(target) } catch { return new Response('bad url', { status: 400 }) }
    if (!/(^|\.)lumosgg\.com$|^lumoskomik\.com$/.test(t.hostname)) return new Response('host not allowed', { status: 400 })
    const h = new Headers()
    for (const k of ['user-agent', 'accept', 'accept-language', 'referer']) {
      const v = req.headers.get(k)
      if (v) h.set(k, v)
    }
    const r = await fetch(t.toString(), { headers: h, redirect: 'follow' })
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/plain' } })
  }
}

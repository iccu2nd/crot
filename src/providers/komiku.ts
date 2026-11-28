import https from 'node:https'
import { NotFoundError, TimeoutError, UpstreamError } from '../core/errors.js'
import { cid, isoDate, numOrNull, pathSegment, sid, splitOnce } from '../core/util.js'
import type { ChapterContent, ChapterSummary, ProviderAdapter, SeriesDetail, SeriesStatus, SeriesSummary } from '../core/types.js'

const KEY = 'komiku'
/** Situs utama + API listing/pencarian (situs memuat daftar lewat `api.komiku.org`). Ubah lewat env bila domain pindah. */
const BASE = (process.env.KOMIKU_BASE || 'https://komiku.org').replace(/\/+$/, '')
const API = (process.env.KOMIKU_API || 'https://api.komiku.org').replace(/\/+$/, '')
const UA = process.env.KOMIKU_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
/** Opsional: `cf_clearance=...` bila situs menampilkan tantangan Cloudflare (harus sepasang dengan KOMIKU_UA). */
const COOKIE = process.env.KOMIKU_COOKIE || ''
const TIMEOUT_MS = 8000

type Raw = Record<string, any>

// ---------------------------------------------------------------- util teks / HTML
const decode = (s: string) =>
  s
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&hellip;/g, '...')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
const text = (s: unknown) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(v => v !== undefined)
const stripPrefix = (s: string) => s.replace(/^(?:komik|manga|manhwa|manhua)\s+/i, '').trim()
const byNumber = (a: { number: string }, b: { number: string }) => (parseFloat(b.number) || 0) - (parseFloat(a.number) || 0)

const BLOCKED = /just a moment|cf-browser-verification|attention required|enable javascript and cookies/i
const blocked = (body: string) => body.length < 15000 && (BLOCKED.test(body) || (/challenge-platform/i.test(body) && /cf_chl_opt/i.test(body)))

// ---------------------------------------------------------------- HTTP (fetch; cadangan DoH bila DNS ISP/host memblokir)
const DOH = [
  { ip: '1.1.1.1', host: 'cloudflare-dns.com', path: (d: string) => `/dns-query?name=${encodeURIComponent(d)}&type=A` },
  { ip: '8.8.8.8', host: 'dns.google', path: (d: string) => `/resolve?name=${encodeURIComponent(d)}&type=A` },
  { ip: '9.9.9.9', host: 'dns.quad9.net', path: (d: string) => `/dns-query?name=${encodeURIComponent(d)}&type=A` }
]
const dnsCache = new Map<string, string>()

function httpsGet(o: { ip: string; servername: string; path: string; headers: Record<string, string> }): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: o.ip, port: 443, path: o.path, method: 'GET', servername: o.servername, headers: { ...o.headers, host: o.servername, 'accept-encoding': 'identity' }, timeout: TIMEOUT_MS }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

async function resolveViaDoh(host: string): Promise<string> {
  const hit = dnsCache.get(host)
  if (hit) return hit
  let last: unknown
  for (const p of DOH) {
    try {
      const r = await httpsGet({ ip: p.ip, servername: p.host, path: p.path(host), headers: { accept: 'application/dns-json', 'user-agent': UA } })
      const ip = (JSON.parse(r.body).Answer ?? []).find((a: Raw) => a.type === 1)?.data
      if (ip) {
        dnsCache.set(host, ip)
        return ip
      }
    } catch (e) {
      last = e
    }
  }
  throw new UpstreamError(`DNS ${host} gagal (${(last as Error)?.message || 'tidak ada A record'})`)
}

const isNetworkDns = (e: unknown) => /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|fetch failed/i.test(`${(e as any)?.cause?.code ?? ''} ${(e as Error)?.message ?? ''}`)

function reqHeaders(referer?: string): Record<string, string> {
  return {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    referer: referer ?? `${BASE}/`,
    ...(COOKIE ? { cookie: COOKIE } : {})
  }
}

function checkStatus(status: number, headers: { get(n: string): unknown }): void {
  if (status === 404 || status === 410) throw new NotFoundError('Not found upstream')
  if (status < 200 || status >= 300) {
    const mit = headers.get('cf-mitigated')
    throw new UpstreamError(`HTTP ${status}${mit ? ` [cf-mitigated: ${mit}]` : ''}`, status)
  }
}

async function fetchOne(url: string, referer?: string): Promise<string> {
  let body: string
  try {
    const res = await fetch(url, { headers: reqHeaders(referer), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
    checkStatus(res.status, res.headers)
    body = await res.text()
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof UpstreamError) throw e
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') throw new TimeoutError('Komiku timeout')
    if (!isNetworkDns(e)) throw new UpstreamError(`Komiku gagal (${(e as Error)?.message || 'error'})`)
    // DNS/jaringan bermasalah -> resolve lewat DoH lalu sambung langsung ke IP (SNI tetap nama host).
    const u = new URL(url)
    try {
      const ip = await resolveViaDoh(u.hostname)
      const r = await httpsGet({ ip, servername: u.hostname, path: u.pathname + u.search, headers: reqHeaders(referer) })
      checkStatus(r.status, { get: n => r.headers[n] })
      body = r.body
    } catch (e2) {
      if (e2 instanceof NotFoundError || e2 instanceof UpstreamError) throw e2
      throw new TimeoutError(`Komiku tidak terjangkau (${(e2 as Error)?.message || 'error'})`)
    }
  }
  if (blocked(body)) throw new UpstreamError('diblokir Cloudflare (halaman tantangan); isi KOMIKU_COOKIE + KOMIKU_UA', 403)
  return body
}

/** GET dengan cadangan domain `komiku.id` (situs yang sama) bila domain utama gagal. 404 langsung dilempar. */
async function http(url: string, referer?: string): Promise<string> {
  const alt = /\/\/komiku\.org(?=[/?#]|$)/.test(url) ? [url.replace('//komiku.org', '//komiku.id')] : []
  let last: unknown
  for (const u of [url, ...alt]) {
    try {
      return await fetchOne(u, referer)
    } catch (e) {
      if (e instanceof NotFoundError) throw e
      last = e
    }
  }
  throw last
}

// ---------------------------------------------------------------- URL / slug
const HOSTS = new Set(['komiku.org', 'www.komiku.org', 'komiku.id', 'www.komiku.id', 'api.komiku.org', 'api.komiku.id', 'secure.komikid.org', 'komikid.org', new URL(BASE).hostname, new URL(API).hostname])

function abs(href?: string | null): string {
  if (!href) return ''
  const h = decode(href).trim()
  if (!h || h === '#' || /^(data|blob|javascript):/i.test(h)) return ''
  try {
    return new URL(h, BASE + '/').toString()
  } catch {
    return ''
  }
}

/** `/manga/<slug>/` -> slug (hanya host Komiku). */
function mangaSlug(href: string): string | null {
  try {
    const u = new URL(href)
    if (!HOSTS.has(u.hostname)) return null
    const m = u.pathname.match(/^\/manga\/([a-z0-9][a-z0-9-]*)\/?$/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** `/<series>-chapter-179-5/` -> "<series>-chapter-179-5" (slug chapter; tidak harus berawalan slug manga). */
function chapterSlug(href: string): string | null {
  try {
    const u = new URL(href)
    if (!HOSTS.has(u.hostname)) return null
    const m = u.pathname.match(/^\/([a-z0-9][a-z0-9-]*-chapter-\d+(?:-\d+)?)\/?$/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** `lookism-chapter-540` -> "540", `x-chapter-12-5` -> "12.5". */
function numberFromSlug(ch: string): string {
  const m = ch.match(/-chapter-(\d+)(?:-(\d+))?$/i)
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : ch
}

// ---------------------------------------------------------------- gambar
const PLACEHOLDER = /(?:^|[/_.-])(?:lazy|placeholder|blank|spinner|loading|default)(?:[/_.-]|$)|\/asset\/img\//i
const IMG_EXT = /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i
const BAD_PAGE = /(?:^|[/_.-])(?:ads?|banner|promo|promosi|iklan|logo|favicon|avatar)(?:[/_.-]|\d|$)/i

/** URL gambar dari tag <img>: atribut lazy (data-src, ...) DIDAHULUKAN; `src` biasanya hanya placeholder `lazy.jpg`. */
function imgUrl(tag: string | undefined): string {
  if (!tag) return ''
  const srcset = attr(tag, 'srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
  for (const c of [attr(tag, 'data-src'), attr(tag, 'data-lazy-src'), attr(tag, 'data-original'), attr(tag, 'data-cfsrc'), srcset, attr(tag, 'src')]) {
    const u = abs(c)
    if (u && !PLACEHOLDER.test(u)) return u
  }
  return ''
}

// ---------------------------------------------------------------- tanggal / status
const UNIT_MS: Record<string, number> = { detik: 1e3, menit: 6e4, jam: 36e5, hari: 864e5, minggu: 6048e5, bulan: 2592e6, tahun: 31536e6, second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }
function dateOf(raw: string, now = Date.now()): string | null {
  const t = raw.toLowerCase().trim()
  if (!t) return null
  if (/baru saja|just now/.test(t)) return new Date(now).toISOString()
  if (/kemarin|yesterday/.test(t)) return new Date(Math.floor((now - 864e5) / 864e5) * 864e5).toISOString()
  const rel = t.match(/(\d+)\s*(detik|menit|jam|hari|minggu|bulan|tahun|second|minute|hour|day|week|month|year)s?\s*(?:lalu|ago)/)
  if (rel) {
    const ms = UNIT_MS[rel[2]] * parseInt(rel[1], 10)
    const at = now - ms
    return new Date(ms >= 864e5 ? Math.floor(at / 864e5) * 864e5 : at).toISOString()
  }
  const dmy = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/)
  if (dmy) {
    const d = Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1])
    return Number.isFinite(d) && d <= now + 864e5 ? new Date(d).toISOString() : null
  }
  const iso = isoDate(raw.match(/\d{4}-\d{2}-\d{2}(?:[T ][\d:]+Z?)?/)?.[0] ?? raw)
  return iso && Date.parse(iso) <= now + 864e5 ? iso : null
}

function statusOf(s: unknown): SeriesStatus | null {
  const v = String(s ?? '').toLowerCase()
  if (/hiatus/.test(v)) return 'hiatus'
  if (/tamat|selesai|complete|end\b/.test(v)) return 'completed'
  if (/berjalan|ongoing|on going/.test(v)) return 'ongoing'
  return null
}

// ---------------------------------------------------------------- kartu daftar (pencarian / latest)
interface Card {
  slug: string
  title: string
  cover: string
  type: string | null
  latest: number | null
  latestLabel: string | null
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')

function cardFrom(block: string): Card | null {
  let slug: string | null = null
  let anchor = ''
  for (const m of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    slug = mangaSlug(abs(attr(m[1], 'href')))
    if (slug) {
      anchor = m[0]
      break
    }
  }
  if (!slug) return null
  const img = block.match(/<img\b[^>]*>/i)?.[0]
  const heading = text(block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1])
  const title = stripPrefix(heading || text(attr(anchor, 'title')) || text(img && attr(img, 'alt')) || text(anchor))
  if (!title || title.length > 160) return null
  let latest: number | null = null
  let latestLabel: string | null = null
  for (const m of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const ch = chapterSlug(abs(attr(m[1], 'href')))
    if (!ch) continue
    const num = numberFromSlug(ch)
    const n = parseFloat(num)
    if (Number.isFinite(n) && (latest === null || n > latest)) {
      latest = n
      latestLabel = num
    }
  }
  return { slug, title, cover: imgUrl(img), type: text(block.match(/class="[^"]*tpe1_inf[^"]*"[^>]*>\s*<b[^>]*>([\s\S]*?)<\/b>/i)?.[1]).toLowerCase() || null, latest, latestLabel }
}

/** Kartu `.bge` (hasil listing/pencarian Komiku); bila markup berbeda, jatuh ke anchor `/manga/<slug>/` di seluruh halaman. */
function parseCards(html: string): Card[] {
  const out = new Map<string, Card>()
  const add = (c: Card | null) => {
    if (!c) return
    const prev = out.get(c.slug)
    if (!prev) out.set(c.slug, c)
    else {
      prev.cover ||= c.cover
      prev.type ||= c.type
      if (c.latest !== null && (prev.latest === null || c.latest > prev.latest)) Object.assign(prev, { latest: c.latest, latestLabel: c.latestLabel })
    }
  }
  const blocks = html.split(/<(?:div|article)\b[^>]*class="[^"]*\bbge\b[^"]*"[^>]*>/i).slice(1)
  if (blocks.length) blocks.forEach(b => add(cardFrom(b)))
  else
    for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const slug = mangaSlug(abs(attr(m[1], 'href')))
      if (slug) add(cardFrom(m[0]))
    }
  return [...out.values()]
}

function toSummary(c: Card): SeriesSummary {
  const id = sid(KEY, c.slug)
  return {
    id,
    provider: KEY,
    title: c.title,
    cover: c.cover,
    url: `${BASE}/manga/${c.slug}/`,
    type: c.type && /^(manga|manhwa|manhua|comic|novel)$/.test(c.type) ? c.type : null,
    status: null,
    genres: [],
    rating: null,
    chapterCount: null,
    latestChapter: c.latestLabel,
    sources: [{ provider: KEY, id }]
  }
}

const dedupe = (list: SeriesSummary[]) => [...new Map(list.map(s => [s.id, s])).values()]
const pageSeg = (page: number) => (page > 1 ? `page/${page}/` : '')

// ---------------------------------------------------------------- pencarian
/** Halaman hasil memuat widget lain (populer/rekomendasi): hanya judul/slug yang memuat semua kata kunci yang dipakai. */
function matches(q: string) {
  const tokens = q.toLowerCase().split(/\s+/).map(norm).filter(Boolean)
  return (c: { title: string; slug: string }) => tokens.every(t => norm(c.title).includes(t) || norm(c.slug).includes(t))
}

async function searchHtml(url: string, q: string): Promise<SeriesSummary[]> {
  try {
    const keep = matches(q)
    return parseCards(await http(url)).filter(keep).map(toSummary)
  } catch (e) {
    if (e instanceof NotFoundError) return [] // halaman di luar hasil
    throw e
  }
}

/** WP REST (jika tersedia): judul + link saja (tanpa cover). */
async function searchWp(q: string, page: number): Promise<SeriesSummary[]> {
  for (const ep of ['manga', 'komik']) {
    let data: unknown
    try {
      data = JSON.parse(await http(`${BASE}/wp-json/wp/v2/${ep}?search=${encodeURIComponent(q)}&per_page=20&page=${page}`))
    } catch {
      continue
    }
    if (!Array.isArray(data)) continue
    const rows: SeriesSummary[] = []
    for (const it of data as Raw[]) {
      const slug = mangaSlug(abs(it?.link))
      const title = stripPrefix(text(it?.title?.rendered ?? it?.title))
      if (slug && title) rows.push(toSummary({ slug, title, cover: '', type: null, latest: null, latestLabel: null }))
    }
    if (rows.length) return rows
  }
  return []
}

async function search(q: string, page: number, limit: number): Promise<SeriesSummary[]> {
  const enc = encodeURIComponent(q)
  const jobs = [
    searchHtml(`${API}/${pageSeg(page)}?post_type=manga&s=${enc}`, q), // endpoint pencarian situs (form pencarian -> api.komiku.org)
    searchHtml(`${BASE}/${pageSeg(page)}?post_type=manga&s=${enc}`, q),
    searchHtml(`${BASE}/pustaka/${pageSeg(page)}?s=${enc}`, q),
    searchWp(q, page)
  ]
  const res = await Promise.allSettled(jobs)
  const rows = dedupe(res.flatMap(r => (r.status === 'fulfilled' ? r.value : [])))
  // WP REST bersifat opsional (gagal = kosong); provider dianggap gagal bila SEMUA halaman HTML gagal.
  const html = res.slice(0, 3)
  if (!rows.length && html.every(r => r.status === 'rejected')) throw (html[0] as PromiseRejectedResult).reason
  return rows.slice(0, Math.max(limit, 40))
}

// ---------------------------------------------------------------- latest / katalog
async function listPage(page: number, withHome: boolean): Promise<SeriesSummary[]> {
  const urls = [`${API}/manga/${pageSeg(page)}?orderby=modified`, ...(withHome && page === 1 ? [`${BASE}/`] : []), `${BASE}/pustaka/${pageSeg(page)}?orderby=modified`]
  let last: unknown
  for (const u of urls) {
    try {
      const rows = parseCards(await http(u)).map(toSummary)
      if (rows.length) return rows
    } catch (e) {
      if (!(e instanceof NotFoundError)) last = e
    }
  }
  if (last) throw last
  return []
}

// ---------------------------------------------------------------- detail
const SYN_STOP = /^(sinopsis|synopsis)$/i

function infoRows(html: string): Record<string, string> {
  const info: Record<string, string> = {}
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1])
    if (cells.length < 2) continue
    const key = text(cells[0]).toLowerCase().replace(/[:\s]+$/, '')
    const links = [...cells[cells.length > 2 ? 1 : cells.length - 1].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(a => text(a[1])).filter(Boolean)
    const value = links.length ? links.join(', ') : text(cells[cells.length > 2 ? 1 : cells.length - 1])
    if (key && key.length <= 40 && value && !(key in info)) info[key] = value
  }
  return info
}
const pickInfo = (info: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(info).find(x => x === k || x.startsWith(k))
    if (hit) return info[hit]
  }
  return ''
}

function synopsisOf(html: string): string {
  const at = html.search(/id=["']Sinopsis["']/i)
  if (at >= 0) {
    const region = html.slice(at, at + 6000).split(/<\/section>|id=["'](?:Informasi|Daftar_Chapter|Genre)["']/i)[0]
    const ps = [...region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(p => text(p[1])).filter(t => t.length > 20 && !SYN_STOP.test(t))
    if (ps.length) return ps.join('\n\n')
  }
  const desc = text(html.match(/<p\b[^>]*class="[^"]*\bdesc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1])
  if (desc) return desc
  const meta = html.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]*>/i)?.[0]
  return meta ? text(attr(meta, 'content')) : ''
}

function parseChapters(html: string): (ChapterSummary & { chapter: string })[] {
  // Daftar chapter ada di #Daftar_Chapter; slug chapter bisa berbeda dari slug manga, jadi tidak dicocokkan dengan slug.
  const at = html.search(/id=["']Daftar_Chapter["']/i)
  const region = at >= 0 ? html.slice(at).split(/<\/table>/i)[0] : html
  const found = new Map<string, { number: string; title: string; date: string | null }>()
  const rows = region.split(/<tr\b/i).slice(1)
  for (const row of rows.length ? rows : [region]) {
    for (const m of row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const ch = chapterSlug(abs(attr(m[1], 'href')))
      if (!ch || found.has(ch)) continue
      const label = text(m[2])
      const num = label.match(/\bchapter\s*(\d+(?:\.\d+)?)/i)?.[1] ?? numberFromSlug(ch)
      const date = dateOf(text(row.match(/<td\b[^>]*class="[^"]*tanggalseries[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1])) ?? dateOf(text(row.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i)?.[1]))
      const rest = label.replace(/\bchapter\s*\d+(?:\.\d+)?/i, '').replace(/^[\s:\-–|•·]+|[\s:\-–|•·]+$/g, '').trim()
      found.set(ch, { number: num, title: rest.length > 100 ? '' : rest, date })
    }
  }
  return [...found]
    .map(([chapter, c]) => ({ chapter, id: '', number: c.number, title: c.title, date: c.date }))
    .sort(byNumber)
}

async function detail(slug: string): Promise<SeriesDetail> {
  const html = await http(`${BASE}/manga/${pathSegment(slug)}/`)
  const id = sid(KEY, slug)
  const chapters = parseChapters(html).map(c => ({ ...c, id: cid(KEY, `${slug}:${c.chapter}`) }))
  const info = infoRows(html)
  const title = stripPrefix(text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1])) || stripPrefix(text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s*[-|–].*$/, ''))
  if (!title && !chapters.length) throw new NotFoundError('Manga tidak ditemukan')
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i)?.[0]
  const ogUrl = og ? abs(attr(og, 'content')) : ''
  const coverTag = html.match(/<img\b[^>]*itemprop=["']image["'][^>]*>/i)?.[0] ?? html.match(/<img\b[^>]*class="[^"]*\bsd\b[^"]*"[^>]*>/i)?.[0]
  const genres = [
    ...new Set(
      [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
        .filter(a => /\/genre\/[^/"'?#]+/i.test(attr(a[1], 'href') ?? ''))
        .map(a => text(a[2]))
        .filter(g => g && g.length < 40)
    )
  ]
  const type = pickInfo(info, 'jenis komik', 'jenis', 'tipe', 'type').toLowerCase()
  return {
    id,
    provider: KEY,
    title: title || slug,
    cover: (ogUrl && !PLACEHOLDER.test(ogUrl) ? ogUrl : '') || imgUrl(coverTag),
    url: `${BASE}/manga/${slug}/`,
    type: /^(manga|manhwa|manhua|comic|novel)$/.test(type) ? type : null,
    status: statusOf(pickInfo(info, 'status')),
    genres,
    rating: null,
    chapterCount: chapters.length,
    latestChapter: chapters[0]?.number ?? null,
    sources: [{ provider: KEY, id }],
    synopsis: synopsisOf(html),
    author: pickInfo(info, 'pengarang', 'komikus', 'author', 'penulis'),
    artist: pickInfo(info, 'ilustrator', 'artist', 'seniman'),
    year: numOrNull(pickInfo(info, 'rilis', 'tahun', 'released', 'year').match(/\b(19|20)\d{2}\b/)?.[0]),
    chapters: chapters.map(({ chapter: _c, ...c }) => c)
  }
}

// ---------------------------------------------------------------- chapter
function pageImages(html: string): string[] {
  const at = html.search(/id=["']Baca_Komik["']/i)
  const scoped = at >= 0 ? html.slice(at) : html
  const pick = (src: string, loose: boolean) => {
    const out: string[] = []
    for (const tag of src.match(/<img\b[^>]*>/gi) ?? []) {
      const u = imgUrl(tag)
      if (!u || BAD_PAGE.test(u) || !IMG_EXT.test(u)) continue
      if (!loose || /\/upload/i.test(u)) out.push(u)
    }
    return [...new Set(out)]
  }
  const scopedImgs = pick(scoped, false)
  return scopedImgs.length || at < 0 ? scopedImgs : pick(html, true)
}

const imageHeaders = (): Record<string, string> => ({ 'user-agent': UA, referer: `${BASE}/`, origin: BASE, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' })

async function chapter(ref: string): Promise<ChapterContent> {
  const [slug, ch] = splitOnce(ref)
  const html = await http(`${BASE}/${pathSegment(ch)}/`, `${BASE}/manga/${pathSegment(slug)}/`)
  const images = pageImages(html)
  if (!images.length) throw new UpstreamError(`gambar chapter tidak ditemukan (html ${html.length}B, ${(html.match(/<img\b/gi) ?? []).length} img)`)

  let prev: string | null = null
  let next: string | null = null
  const link = (href?: string | null) => {
    const c = href ? chapterSlug(abs(href)) : null
    return c && c !== ch ? cid(KEY, `${slug}:${c}`) : null
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase()
    if (rel === 'prev') prev ??= link(attr(m[0], 'href'))
    else if (rel === 'next') next ??= link(attr(m[0], 'href'))
  }
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const target = link(attr(m[1], 'href'))
    if (!target) continue
    const label = text(m[2]).toLowerCase()
    const hint = `${attr(m[1], 'rel') ?? ''} ${attr(m[1], 'class') ?? ''}`.toLowerCase()
    if (!prev && (/\bprev(ious)?\b|sebelum/.test(hint) || /\bprev(ious)?\b|sebelum|«|‹|←/.test(label))) prev = target
    else if (!next && (/\bnext\b|berikut|selanjut/.test(hint) || /\bnext\b|berikut|selanjut|»|›|→/.test(label))) next = target
  }
  // Prev/next dari urutan nomor chapter bila tombol tidak ditemukan (tanpa menebak chapter yang tak terdaftar).
  if (!prev || !next) {
    const cur = parseFloat(numberFromSlug(ch))
    const seen = new Map<string, number>()
    for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
      const c = chapterSlug(abs(attr(m[1], 'href')))
      if (c && c !== ch) seen.set(c, parseFloat(numberFromSlug(c)))
    }
    const all = [...seen].filter(([, n]) => Number.isFinite(n))
    const before = all.filter(([, n]) => n < cur).sort((a, b) => b[1] - a[1])[0]?.[0]
    const after = all.filter(([, n]) => n > cur).sort((a, b) => a[1] - b[1])[0]?.[0]
    if (!prev && before) prev = cid(KEY, `${slug}:${before}`)
    if (!next && after) next = cid(KEY, `${slug}:${after}`)
  }

  return { id: cid(KEY, `${slug}:${ch}`), seriesId: sid(KEY, slug), number: numberFromSlug(ch), images, prev, next, imageHeaders: imageHeaders() }
}

export function createKomiku(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Komiku',
    baseUrl: BASE,
    search: (q, { page, limit }) => search(q, page, limit),
    latest: async ({ page, limit }) => (page === 1 ? (await listPage(1, true)).slice(0, Math.max(limit, 30)) : listPage(page, false)),
    catalog: ({ page }) => listPage(page, false),
    detail: ref => detail(ref),
    chapter: ref => chapter(ref),
    imageHeaders
  }
}

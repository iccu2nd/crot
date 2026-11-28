import { NotFoundError, TimeoutError, UpstreamError } from '../core/errors.js'
import { cid, isoDate, numOrNull, pathSegment, sid, splitOnce } from '../core/util.js'
import type { ChapterContent, ChapterSummary, ProviderAdapter, SeriesDetail, SeriesStatus, SeriesSummary } from '../core/types.js'

const KEY = 'kiryuu'
// Kiryuu sering pindah domain (v1..v7); ubah di sini atau lewat env KIRYUU_BASE.
const BASE = (process.env.KIRYUU_BASE || 'https://v7.kiryuu.to').replace(/\/+$/, '')
const UA = process.env.KIRYUU_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
/** Opsional: cookie `cf_clearance=...` hasil browser (harus sepasang dengan KIRYUU_UA) bila situs menampilkan tantangan Cloudflare. */
const COOKIE = process.env.KIRYUU_COOKIE || ''
const TIMEOUT_MS = 8000
const NONCE_TTL_MS = 30 * 60_000
const LATEST_PATH = '/advanced-search/?orderby=updated'

type Raw = Record<string, any>

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
const byNumber = (a: { number: string }, b: { number: string }) => (parseFloat(b.number) || 0) - (parseFloat(a.number) || 0)

const BLOCKED = /just a moment|cf-browser-verification|attention required|enable javascript and cookies/i
const blocked = (body: string) => body.length < 15000 && (BLOCKED.test(body) || (/challenge-platform/i.test(body) && /cf_chl_opt/i.test(body)))

async function http(path: string, o: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(/^https?:\/\//.test(path) ? path : BASE + path, {
      method: o.method ?? 'GET',
      body: o.body,
      signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'id,en-US;q=0.9,en;q=0.8',
        referer: `${BASE}/`,
        ...(COOKIE ? { cookie: COOKIE } : {}),
        ...o.headers
      }
    })
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') throw new TimeoutError('Kiryuu timeout')
    throw new UpstreamError(`Kiryuu gagal (${(e as Error)?.message || 'error'})`)
  }
  if (res.status === 404) {
    await res.body?.cancel()
    throw new NotFoundError('Not found upstream')
  }
  if (!res.ok) {
    await res.body?.cancel()
    const mit = res.headers.get('cf-mitigated')
    throw new UpstreamError(`HTTP ${res.status}${mit ? ` [cf-mitigated: ${mit}]` : ''}`, res.status)
  }
  const body = await res.text()
  if (blocked(body)) throw new UpstreamError('diblokir Cloudflare (halaman tantangan); isi KIRYUU_COOKIE + KIRYUU_UA', 403)
  return body
}

// ---- util parsing ----
const abs = (href?: string | null): string => {
  if (!href) return ''
  const h = decode(href).trim()
  if (!h || /^(data|blob|javascript):/i.test(h) || h === '#') return ''
  try {
    return new URL(h, BASE + '/').toString()
  } catch {
    return ''
  }
}

const IMG_EXT = /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i
const NOT_COVER = /gravatar\.com|\/avatar|logo|favicon|\/icons?\/|emoji|spinner|loading|placeholder|blank\.|\/ads?\//i

function imgUrl(tag: string): string {
  const cand = [attr(tag, 'data-src'), attr(tag, 'data-lazy-src'), attr(tag, 'data-original'), attr(tag, 'src'), attr(tag, 'srcset')?.split(',')[0]?.trim().split(/\s+/)[0]]
  for (const c of cand) {
    const u = abs(c)
    if (u && !NOT_COVER.test(u)) return u
  }
  return ''
}

const UNIT_MS: Record<string, number> = { second: 1e3, detik: 1e3, minute: 6e4, menit: 6e4, hour: 36e5, jam: 36e5, day: 864e5, hari: 864e5, week: 6048e5, minggu: 6048e5, month: 2592e6, bulan: 2592e6, year: 31536e6, tahun: 31536e6 }
const REL = /(?:(\d+)|\b(?:an?|se)\b)\s*(second|minute|hour|day|week|month|year|detik|menit|jam|hari|minggu|bulan|tahun)s?\s*(?:ago|lalu)/i
function dateOf(raw: string, now = Date.now()): string | null {
  const t = raw.toLowerCase()
  if (/just now|baru saja/.test(t)) return new Date(now).toISOString()
  if (/yesterday|kemarin/.test(t)) return new Date(Math.floor((now - 864e5) / 864e5) * 864e5).toISOString()
  const m = t.match(REL)
  if (m) {
    const ms = UNIT_MS[m[2]] * (m[1] ? parseInt(m[1], 10) : 1)
    const at = now - ms
    return new Date(ms >= 864e5 ? Math.floor(at / 864e5) * 864e5 : at).toISOString()
  }
  const abs = raw.match(/\d{4}-\d{2}-\d{2}(?:[T ][\d:]+Z?)?|[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/)
  const iso = abs ? isoDate(abs[0]) : null
  return iso && Date.parse(iso) <= now + 864e5 ? iso : null
}

function statusOf(s: unknown): SeriesStatus | null {
  const v = String(s ?? '').toLowerCase()
  if (/hiatus/.test(v)) return 'hiatus'
  if (/complete|tamat|selesai|end\b/.test(v)) return 'completed'
  if (/ongoing|on going|berjalan/.test(v)) return 'ongoing'
  return null
}

/** `/manga/<slug>/` -> slug; `/manga/<slug>/<chapter>/` -> { slug, chapter }. */
function route(href: string): { slug: string; chapter: string | null } | null {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return null
  }
  if (u.origin !== new URL(BASE).origin) return null
  const p = u.pathname.split('/').filter(Boolean)
  if (p[0] !== 'manga' || !p[1]) return null
  if (p.length === 2) return { slug: decodeURIComponent(p[1]), chapter: null }
  if (p.length === 3 && /^chapter/i.test(p[2])) return { slug: decodeURIComponent(p[1]), chapter: decodeURIComponent(p[2]) }
  return null
}

/** `chapter-179.6.425255` -> "179.6", `chapter-0.147843` -> "0", `chapter-12` -> "12". */
function numberFromSlug(chapter: string): string {
  const m = chapter.match(/^chapter-(\d+(?:[.-]\d+)?)\.\d{3,}$/i) ?? chapter.match(/^chapter-(\d+(?:[.-]\d+)?)$/i)
  return (m?.[1] ?? chapter.replace(/^chapter-?/i, '')).replace('-', '.')
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi

interface Card {
  slug: string
  title: string
  heading: boolean
  cover: string
  latest: number | null
  latestLabel: string | null
}

/** Kartu seri dari HTML apa pun: kumpulkan anchor `/manga/<slug>/` (judul + cover) dan anchor chapter (chapter terbaru). */
function parseCards(html: string): Card[] {
  const cards = new Map<string, Card>()
  const get = (slug: string): Card => {
    let c = cards.get(slug)
    if (!c) cards.set(slug, (c = { slug, title: '', heading: false, cover: '', latest: null, latestLabel: null }))
    return c
  }
  for (const m of html.matchAll(ANCHOR)) {
    const r = route(abs(attr(m[1], 'href')))
    if (!r) continue
    const inner = m[2]
    if (r.chapter) {
      const num = text(inner).match(/chapter\s*(\d+(?:\.\d+)?)/i)?.[1] ?? numberFromSlug(r.chapter)
      const c = get(r.slug)
      const n = parseFloat(num)
      if (Number.isFinite(n) && (c.latest === null || n > c.latest)) {
        c.latest = n
        c.latestLabel = num
      }
      continue
    }
    const c = get(r.slug)
    const img = inner.match(/<img\b[^>]*>/i)?.[0]
    if (img && !c.cover) c.cover = imgUrl(img)
    const heading = text(inner.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1])
    if (heading && !c.heading) {
      c.title = heading
      c.heading = true
    } else if (!c.title) {
      const alt = img ? text(attr(img, 'alt')) : ''
      const plain = text(inner)
      c.title = alt || text(attr(m[1], 'title')) || (plain.length <= 120 ? plain : '')
    }
  }
  return [...cards.values()].filter(c => c.title)
}

function toSummary(c: Card): SeriesSummary {
  const id = sid(KEY, c.slug)
  return {
    id,
    provider: KEY,
    title: c.title,
    cover: c.cover,
    url: `${BASE}/manga/${c.slug}/`,
    type: null,
    status: null,
    genres: [],
    rating: null,
    chapterCount: null,
    latestChapter: c.latestLabel,
    sources: [{ provider: KEY, id }]
  }
}

// ---- pencarian ----
let nonce = { v: '', at: 0 }
async function getNonce(force = false): Promise<string> {
  if (!force && nonce.v && Date.now() - nonce.at < NONCE_TTL_MS) return nonce.v
  const html = await http('/')
  const v =
    html.match(/nonce=([0-9a-zA-Z]{6,})(?:&(?:amp;|#0?38;)?|&)[^"'\s]{0,40}action=search/i)?.[1] ??
    html.match(/action=search(?:&(?:amp;|#0?38;)?)[^"'\s]{0,40}nonce=([0-9a-zA-Z]{6,})/i)?.[1] ??
    html.match(/["']nonce["']\s*:\s*["']([0-9a-zA-Z]{6,})["']/i)?.[1]
  if (!v) throw new UpstreamError('nonce pencarian Kiryuu tidak ditemukan')
  nonce = { v, at: Date.now() }
  return v
}

async function searchAjax(q: string): Promise<SeriesSummary[]> {
  const run = async (force: boolean) => {
    const n = await getNonce(force)
    return http(`/wp-admin/admin-ajax.php?nonce=${n}&action=search`, {
      method: 'POST',
      body: `query=${encodeURIComponent(q)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true', 'hx-target': 'searchModalContent', 'hx-current-url': `${BASE}/`, accept: '*/*' }
    })
  }
  let html: string
  try {
    html = await run(false)
  } catch (e) {
    if (e instanceof NotFoundError || (e instanceof UpstreamError && e.upstreamStatus !== 403 && e.upstreamStatus !== 400)) throw e
    html = await run(true) // nonce kedaluwarsa
  }
  return parseCards(html).map(toSummary)
}

async function searchPage(q: string, page: number): Promise<SeriesSummary[]> {
  const qs = new URLSearchParams({ search_term: q })
  if (page > 1) qs.set('page', String(page))
  const html = await http(`/advanced-search/?${qs}`)
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
  // Halaman ini juga memuat widget (populer/rekomendasi): buang yang tidak cocok dengan kata kunci.
  return parseCards(html)
    .filter(c => tokens.every(t => c.title.toLowerCase().includes(t) || c.slug.includes(t)))
    .map(toSummary)
}

const dedupe = (list: SeriesSummary[]) => [...new Map(list.map(s => [s.id, s])).values()]

async function search(q: string, page: number, limit: number): Promise<SeriesSummary[]> {
  if (page > 1) return (await searchPage(q, page)).slice(0, limit)
  const [ajax, adv] = await Promise.allSettled([searchAjax(q), searchPage(q, 1)])
  const rows = dedupe([...(ajax.status === 'fulfilled' ? ajax.value : []), ...(adv.status === 'fulfilled' ? adv.value : [])])
  if (!rows.length) {
    const failed = [ajax, adv].find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed && [ajax, adv].every(r => r.status === 'rejected')) throw failed.reason
  }
  return rows.slice(0, limit)
}

async function latest(page: number, limit: number): Promise<SeriesSummary[]> {
  const html = page > 1 ? await http(`${LATEST_PATH}&page=${page}`) : await http('/')
  const cards = parseCards(html)
  // Beranda memuat beberapa bagian; kartu "update terbaru" adalah yang punya link chapter.
  const updated = cards.filter(c => c.latestLabel)
  return (updated.length ? updated : cards).map(toSummary).slice(0, limit)
}

// ---- detail ----
/** Teks halaman jadi baris-baris (tiap elemen = baris) untuk membaca pasangan label/nilai & sinopsis tanpa bergantung class. */
function toLines(html: string): string[] {
  const body = html
    .replace(/<(script|style|svg|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(?:p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|br|span|dt|dd|label|a|button|strong|b)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decode(body)
    .split('\n')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function labelValue(lines: string[], labels: string[]): string {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase().replace(/\s*:\s*$/, '')
    for (const label of labels) {
      if (l === label) {
        const next = lines[i + 1]
        if (next && next.length < 80 && !/^(status|type|tipe|author|penulis|artist|seniman|released|rilis|tahun|rating|genres?)\s*:?$/i.test(next)) return next.replace(/^[:\-\s]+/, '')
      } else if (lines[i].toLowerCase().startsWith(label) && /^[\s:\-]/.test(lines[i].slice(label.length)) && lines[i].length - label.length < 70) {
        const rest = lines[i].slice(label.length).replace(/^[\s:\-]+/, '')
        if (rest) return rest
      }
    }
  }
  return ''
}

const SYN_STOP = /^(chapters?|chapter list|daftar chapter|genres?|status|type|tipe|author|penulis|artist|rating|released|rilis|first chapter|latest chapter|chapter (pertama|terbaru)|bookmark|comments?|komentar|rekomendasi|recommend|similar|related|baca)\b/i

function synopsisOf(lines: string[], html: string): string {
  const i = lines.findIndex(l => /^(synopsis|sinopsis)\s*:?$/i.test(l))
  if (i >= 0) {
    const out: string[] = []
    for (const l of lines.slice(i + 1, i + 12)) {
      if (out.length && l.length < 40 && SYN_STOP.test(l)) break
      if (!out.length && l.length < 40 && SYN_STOP.test(l)) break
      out.push(l)
      if (out.join('\n').length > 2500) break
    }
    const s = out.join('\n').trim()
    if (s) return s
  }
  const meta = html.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]*>/i)?.[0]
  return meta ? text(attr(meta, 'content')) : ''
}

function parseChapters(html: string, slug: string): (ChapterSummary & { chapter: string })[] {
  const found = new Map<string, { number: string; title: string; date: string | null }>()
  for (const m of html.matchAll(ANCHOR)) {
    const r = route(abs(attr(m[1], 'href')))
    if (!r?.chapter || r.slug !== slug) continue
    const raw = text(m[2].replace(/<time\b[\s\S]*?<\/time>/gi, ' '))
    const date = isoDate(m[2].match(/datetime=["']([^"']+)["']/i)?.[1]) ?? dateOf(raw)
    const num = raw.match(/\bchapter\s*(\d+(?:\.\d+)?)/i)?.[1] ?? numberFromSlug(r.chapter)
    const rest = raw.replace(/\bchapter\s*\d+(?:\.\d+)?/i, '').replace(REL, '').replace(/^[\s:\-–|•·]+|[\s:\-–|•·]+$/g, '').trim()
    const prev = found.get(r.chapter)
    if (!prev) found.set(r.chapter, { number: num, title: rest, date })
    else if (!prev.date && date) prev.date = date
  }
  return [...found]
    .map(([chapter, c]) => ({ chapter, id: cid(KEY, `${slug}:${chapter}`), number: c.number, title: c.title.length > 100 ? '' : c.title, date: c.date }))
    .sort(byNumber)
}

function parseRating(html: string, lines: string[]): number | null {
  const v = html.match(/itemprop=["']ratingValue["'][^>]*(?:content=["']([\d.]+)["']|>\s*([\d.]+))/i) ?? undefined
  const raw = v?.[1] ?? v?.[2] ?? labelValue(lines, ['rating', 'skor', 'score']).match(/\d+(?:\.\d+)?/)?.[0]
  const n = numOrNull(raw)
  return n != null && n > 0 && n <= 10 ? n : null
}

async function detail(slug: string): Promise<SeriesDetail> {
  const html = await http(`/manga/${pathSegment(slug)}/`)
  const lines = toLines(html)
  const chapters = parseChapters(html, slug)
  const id = sid(KEY, slug)
  const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i)?.[0]
  const coverTag = html.match(/<img\b[^>]*(?:wp-content\/uploads)[^>]*>/i)?.[0]
  const title = text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) || text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/^Baca\s+/i, '').replace(/\s*(?:\||-)\s*Kiryuu.*$/i, '').replace(/\s+Bahasa Indonesia.*$/i, '')
  if (!title && !chapters.length) throw new NotFoundError('Manga tidak ditemukan')
  const genres = [...new Set([...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(a => /\/(?:genres?|category)\/[^/"'?#]+/i.test(attr(a[1], 'href') ?? '')).map(a => text(a[2])).filter(g => g && g.length < 40))]
  const year = labelValue(lines, ['released', 'rilis', 'tahun', 'year']).match(/\b(19|20)\d{2}\b/)?.[0]
  return {
    id,
    provider: KEY,
    title: title || slug,
    cover: (ogImg && abs(attr(ogImg, 'content'))) || (coverTag && imgUrl(coverTag)) || '',
    url: `${BASE}/manga/${slug}/`,
    type: labelValue(lines, ['type', 'tipe']).toLowerCase() || null,
    status: statusOf(labelValue(lines, ['status'])),
    genres,
    rating: parseRating(html, lines),
    chapterCount: chapters.length,
    latestChapter: chapters[0]?.number ?? null,
    sources: [{ provider: KEY, id }],
    synopsis: synopsisOf(lines, html),
    author: labelValue(lines, ['author', 'penulis', 'pengarang']),
    artist: labelValue(lines, ['artist', 'ilustrator', 'seniman']),
    year: numOrNull(year),
    chapters: chapters.map(({ chapter: _c, ...c }) => c)
  }
}

// ---- chapter ----
const PAGE_BAD = /googleusercontent|blogger\.com|gravatar|\/avatar|logo|banner|favicon|emoji|\/ads?\/|pixel|spacer|loading|placeholder/i

function pageImages(html: string): string[] {
  const all: string[] = []
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const u = [attr(tag, 'data-src'), attr(tag, 'data-lazy-src'), attr(tag, 'data-original'), attr(tag, 'src')].map(abs).find(Boolean)
    if (u && IMG_EXT.test(u) && !PAGE_BAD.test(u) && !/kiryuu/i.test(attr(tag, 'alt') ?? '')) all.push(u)
  }
  if (!all.length) {
    // Beberapa tema menanam daftar gambar sebagai JSON (`"images":[...]`).
    const arr = html.match(/["']images["']\s*:\s*\[([^\]]+)\]/i)?.[1]
    for (const m of arr?.matchAll(/["']([^"']+)["']/g) ?? []) {
      const u = abs(m[1].replace(/\\\//g, '/'))
      if (u && IMG_EXT.test(u) && !PAGE_BAD.test(u)) all.push(u)
    }
  }
  const uniq = [...new Set(all)]
  const reader = uniq.filter(u => !/\/wp-content\/uploads\//i.test(u))
  const pool = reader.length ? reader : uniq
  // Halaman komik bernama berurutan (1.jpg, 2.jpg, ...); gambar lain (rekomendasi, iklan) dibuang bila pola itu ada.
  const numbered = pool.filter(u => /\/\d+\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(u))
  return numbered.length ? numbered : pool
}

async function chapter(ref: string): Promise<ChapterContent> {
  const [slug, ch] = splitOnce(ref)
  const url = `${BASE}/manga/${pathSegment(slug)}/${pathSegment(ch)}/`
  const html = await http(url)
  const images = pageImages(html)
  if (!images.length) throw new UpstreamError('gambar chapter tidak ditemukan')

  let prev: string | null = null
  let next: string | null = null
  const link = (href?: string | null) => {
    const r = route(abs(href))
    return r?.chapter && r.slug === slug && r.chapter !== ch ? cid(KEY, `${slug}:${r.chapter}`) : null
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase()
    if (rel === 'prev') prev ??= link(attr(m[0], 'href'))
    else if (rel === 'next') next ??= link(attr(m[0], 'href'))
  }
  for (const m of html.matchAll(ANCHOR)) {
    const label = text(m[2]).toLowerCase()
    const rel = (attr(m[1], 'rel') ?? '').toLowerCase()
    const cls = (attr(m[1], 'class') ?? '').toLowerCase()
    const target = link(attr(m[1], 'href'))
    if (!target) continue
    if (!prev && (rel.includes('prev') || /\bprev(ious)?\b|sebelumnya/.test(label) || /\bprev\b/.test(cls))) prev = target
    else if (!next && (rel.includes('next') || /\bnext\b|berikutnya|selanjutnya/.test(label) || /\bnext\b/.test(cls))) next = target
  }

  return {
    id: cid(KEY, `${slug}:${ch}`),
    seriesId: sid(KEY, slug),
    number: numberFromSlug(ch),
    images,
    prev,
    next,
    imageHeaders: imageHeaders()
  }
}

const imageHeaders = (): Record<string, string> => ({ 'user-agent': UA, referer: `${BASE}/` })

export function createKiryuu(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Kiryuu',
    baseUrl: BASE,
    search: (q, { page, limit }) => search(q, page, limit),
    latest: ({ page, limit }) => latest(page, limit),
    detail: ref => detail(ref),
    chapter: ref => chapter(ref),
    imageHeaders
  }
}

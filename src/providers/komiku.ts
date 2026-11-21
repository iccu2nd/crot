import { NotFoundError, UpstreamError } from '../core/errors.js'
import { request, retry } from '../core/http.js'
import { cid, sid } from '../core/ids.js'
import type {
  BrowseOptions,
  ChapterContent,
  ChapterSummary,
  ProviderAdapter,
  SeriesDetail,
  SeriesStatus,
  SeriesSummary
} from '../core/types.js'
import { memo, numOrNull, slugify, splitOnce } from '../core/util.js'

const KEY = 'komiku'
// Bisa diganti lewat env bila situs pindah domain, tanpa ubah kode.
const BASE = (process.env.KOMIKU_BASE_URL || 'https://komiku.org').replace(/\/+$/, '')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
  referer: `${BASE}/`
}
const API = (process.env.KOMIKU_API_URL || 'https://api.komiku.org').replace(/\/+$/, '')
const TYPES = ['manga', 'manhwa', 'manhua']

// ── util HTML (tanpa cheerio, mengikuti gaya adapter Lumos) ─────────────
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
const text = (s: unknown) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
/** Nilai atribut dari string tag pembuka (urutan atribut bebas). */
const attr = (tag: string | undefined, name: string): string | null => {
  if (!tag) return null
  const m = tag.match(new RegExp(`[\\s"']${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return m ? decode(m[1] ?? m[2] ?? '') : null
}
const hasClass = (tag: string | undefined, cls: string) => new RegExp(`(?:^|\\s)${cls}(?:\\s|$)`).test(attr(tag, 'class') ?? '')
const openTags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []
const abs = (u: string | null | undefined): string => {
  const v = (u ?? '').trim()
  if (!v || v.startsWith('#') || /^(data|javascript):/i.test(v)) return ''
  try {
    return new URL(v, BASE + '/').toString()
  } catch {
    return ''
  }
}
const lastSegment = (u: string | null | undefined): string => {
  const full = abs(u)
  if (!full) return ''
  const parts = new URL(full).pathname.split('/').filter(Boolean)
  return decodeURIComponent(parts[parts.length - 1] ?? '')
}

const blocked = (html: string) => html.length < 6000 && /just a moment|cf-browser-verification|challenge-platform|attention required/i.test(html)

const getHtml = (path: string, root = BASE, referer = `${BASE}/`): Promise<string> =>
  retry(async () => {
    const html = await (await request(root + path, { headers: { ...HEADERS, referer }, timeoutMs: 15000 })).text()
    if (blocked(html)) throw new UpstreamError('Komiku memblokir request (challenge)')
    return html
  })

// ── tanggal chapter ────────────────────────────────────────────────────
const UNIT_MS: Record<string, number> = { detik: 1e3, menit: 6e4, jam: 36e5, hari: 864e5, minggu: 6048e5, bulan: 2592e6, tahun: 31536e6 }

/** Mendukung ISO / yyyy-mm-dd, dd/mm/yyyy (format Indonesia), dan relatif ("3 hari lalu"). Selain itu null. */
export function parseDate(raw: string | null | undefined, now = Date.now()): string | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return safeIso(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (m) return safeIso(+m[3], +m[2], +m[1])
  m = s.match(/(\d+)\s*(detik|menit|jam|hari|minggu|bulan|tahun)/)
  if (m) return new Date(now - Number(m[1]) * UNIT_MS[m[2]]).toISOString()
  if (/kemarin/.test(s)) return new Date(now - 864e5).toISOString()
  return null
}
function safeIso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString() : null
}

const statusOf = (s: string | undefined): SeriesStatus | null => {
  const v = (s ?? '').toLowerCase()
  if (/tamat|selesai|complet|end/.test(v)) return 'completed'
  if (/hiatus/.test(v)) return 'hiatus'
  if (/berjalan|ongoing|update/.test(v)) return 'ongoing'
  return null
}
const typeOf = (s: string | null | undefined): string | null => {
  const v = (s ?? '').toLowerCase()
  return TYPES.find(t => v.includes(t)) ?? null
}
const numberFromSlug = (slug: string) => slug.match(/chapter-([\d]+(?:-\d+)?)/i)?.[1]?.replace('-', '.') ?? slug

// ── LIST (pustaka, filter, search) ─────────────────────────────────────
/** Kartu `article.ls2` (pustaka/search) dan `article.ls4` (ranking/genre API). */
export function parseList(html: string, genreName?: string): SeriesSummary[] {
  const out: SeriesSummary[] = []
  const seen = new Set<string>()
  for (const art of html.match(/<article\b[^>]*>[\s\S]*?<\/article>/gi) ?? []) {
    const head = art.match(/^<article\b[^>]*>/i)?.[0]
    if (!hasClass(head, 'ls2') && !hasClass(head, 'ls4')) continue
    const href = art.match(/<a\b[^>]*href\s*=\s*"([^"]*\/manga\/[^"]+)"/i)?.[1] ?? ''
    const slug = href.match(/\/manga\/([^/?#]+)/)?.[1]
    if (!slug || seen.has(slug)) continue
    seen.add(slug)

    const imgs = openTags(art, 'img')
    const coverImg = imgs.find(t => !hasClass(t, 'flag'))
    const flag = attr(imgs.find(t => hasClass(t, 'flag')), 'src') ?? ''
    const h3 = art.match(/<h[34]\b[^>]*>([\s\S]*?)<\/h[34]>/i)?.[1] ?? ''
    const h3a = h3.match(/<a\b[^>]*>/i)?.[0]
    const title =
      (attr(h3a, 'title') ?? '').replace(/^Baca\s+(Manga|Manhwa|Manhua|Komik)\s+/i, '').trim() || text(h3) || slug
    const chap = art.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)?.find(a => { const t = a.match(/^<a\b[^>]*>/i)?.[0]; return hasClass(t, 'ls2l') || hasClass(t, 'ls24') })
    const meta = text(art.match(/<(\w+)\b[^>]*class="[^"]*\b(?:ls2t|ls4s)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i)?.[2])
    const genre = meta.split('·')[0]?.trim() || ''
    const id = sid(KEY, slug)
    const lastNo = text(chap).match(/(\d+(?:\.\d+)?)/)?.[1] ?? null

    out.push({
      id,
      provider: KEY,
      title,
      cover: abs(attr(coverImg, 'data-src') || attr(coverImg, 'src')),
      url: abs(href) || `${BASE}/manga/${slug}/`,
      type: flag.includes('jp') ? 'manga' : flag.includes('kr') ? 'manhwa' : flag.includes('cn') ? 'manhua' : null,
      status: null,
      genres: genreName ? [genreName] : genre ? [genre] : [],
      rating: null,
      chapterCount: null,
      latestChapter: lastNo,
      sources: [{ provider: KEY, id }]
    })
  }
  return out
}

/** Slug genre milik Komiku (`a.gnr[data-nama]` di /p/daftar-genre/), di-memo 1 jam. Kunci = slug unified. */
const komikuGenres = memo(
  async () => {
    const html = await getHtml('/p/daftar-genre/')
    const map = new Map<string, { slug: string; name: string }>()
    for (const a of html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
      const tag = a.match(/^<a\b[^>]*>/i)![0]
      if (!hasClass(tag, 'gnr')) continue
      const slug = attr(tag, 'data-nama') ?? ''
      const name = text(a.match(/<b\b[^>]*>([\s\S]*?)<\/b>/i)?.[1])
      if (slug && name) map.set(slugify(slug) || slugify(name), { slug, name })
    }
    return map
  },
  3_600_000,
  1
)

/** Genre lewat endpoint AJAX `api.komiku.org/genre/<slug>/?page=N` (HTML kartu). */
async function byGenre(genre: { slug: string; name: string }, page: number, type?: string): Promise<SeriesSummary[]> {
  const qs = new URLSearchParams({ page: String(page) })
  try {
    const html = await getHtml(`/genre/${encodeURIComponent(genre.slug)}/?${qs}`, API, `${BASE}/genre/${encodeURIComponent(genre.slug)}/`)
    const items = parseList(html, genre.name)
    return type && TYPES.includes(type.toLowerCase()) ? items.filter(i => !i.type || i.type === type.toLowerCase()) : items
  } catch (e) {
    if (e instanceof NotFoundError) return []
    throw e
  }
}

async function pustaka(o: { page: number; type?: string; genre?: string; orderby?: string }): Promise<SeriesSummary[]> {
  const qs = new URLSearchParams({ orderby: o.orderby ?? 'modified' })
  if (o.type && TYPES.includes(o.type.toLowerCase())) qs.set('tipe', o.type.toLowerCase())
  if (o.genre) qs.set('genre', o.genre)
  const path = o.page > 1 ? `/pustaka/page/${o.page}/` : '/pustaka/'
  try {
    return parseList(await getHtml(`${path}?${qs}`))
  } catch (e) {
    if (e instanceof NotFoundError) return [] // halaman melewati batas / genre tak dikenal
    throw e
  }
}

// ── DETAIL ─────────────────────────────────────────────────────────────
export function parseDetail(html: string, ref: string): SeriesDetail {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ''
  const title =
    text(h1.match(/<span\b[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/i)?.[1]) || text(h1).replace(/^Komik\s+/i, '')
  const cover = abs(attr(openTags(html, 'img').find(t => attr(t, 'itemprop') === 'image'), 'src'))
  const synopsis = text(html.match(/<p\b[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/p>/i)?.[1])

  const info: Record<string, string> = {}
  const table = html.match(/<table\b[^>]*class="[^"]*\binftable\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? ''
  for (const tr of table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1])
    const label = text(tds[0]).replace(/:$/, '').trim().toLowerCase().replace(/\s+/g, '_')
    if (label && tds[1] != null && label !== 'genre') info[label] = text(tds[1])
  }
  const genreList = html.match(/<ul\b[^>]*class="[^"]*\bgenre\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] ?? ''
  const genres = [...new Set([...genreList.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => text(m[1])).filter(Boolean))]

  const chapters: ChapterSummary[] = []
  const seen = new Set<string>()
  for (const tr of html.match(/<tr\b[^>]*itemprop="itemListElement"[\s\S]*?<\/tr>/gi) ?? []) {
    const a = openTags(tr, 'a').find(t => attr(t, 'itemprop') === 'url') ?? openTags(tr, 'a')[0]
    const chSlug = lastSegment(attr(a, 'href'))
    if (!chSlug || seen.has(chSlug)) continue
    seen.add(chSlug)
    const name = text(tr.match(/<span\b[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/i)?.[1]) || text(tr.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1])
    const number = name.match(/Chapter\s+([\d]+(?:\.\d+)?)/i)?.[1] ?? numberFromSlug(chSlug)
    const date = text(tr.match(/<td\b[^>]*class="[^"]*\btanggalseries\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1])
    chapters.push({ id: cid(KEY, `${ref}:${chSlug}`), number, title: name, date: parseDate(date) })
  }
  chapters.sort((a, b) => (parseFloat(b.number) || 0) - (parseFloat(a.number) || 0))

  const total = numOrNull(html.match(/<meta\b[^>]*itemprop="numberOfItems"[^>]*>/i)?.[0].match(/content="(\d+)"/)?.[1])
  const id = sid(KEY, ref)
  return {
    id,
    provider: KEY,
    title: title || ref,
    cover,
    url: `${BASE}/manga/${ref}/`,
    type: typeOf(info.jenis_komik ?? info.tipe ?? info.type),
    status: statusOf(info.status),
    genres,
    rating: null,
    chapterCount: chapters.length || total,
    latestChapter: chapters[0]?.number ?? null,
    sources: [{ provider: KEY, id }],
    synopsis,
    author: info.pengarang ?? '',
    artist: info.ilustrator ?? '',
    year: null,
    chapters
  }
}

// ── CHAPTER READER ─────────────────────────────────────────────────────
export function parseChapter(html: string) {
  let data: Record<string, any> | null = null
  const m = html.match(/var chapterData\s*=\s*(\{[\s\S]*?\});/)
  if (m) {
    try {
      data = JSON.parse(m[1])
    } catch {
      /* abaikan: gambar tetap dibaca dari DOM */
    }
  }
  const zone = html.slice(Math.max(0, html.search(/id="Baca_Komik"/i)))
  const images = openTags(zone, 'img')
    .filter(t => hasClass(t, 'ww') && attr(t, 'data-src'))
    .map((t, i) => ({ n: Number(attr(t, 'id')) || i + 1, url: abs(attr(t, 'data-src')) }))
    .filter(x => x.url)
    .sort((a, b) => a.n - b.n)
  const nav = (label: string) => lastSegment(attr(openTags(html, 'a').find(t => attr(t, 'aria-label')?.toLowerCase() === label), 'href'))
  return { data, images: [...new Set(images.map(i => i.url))], prev: nav('prev'), next: nav('next') }
}

export function createKomiku(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Komiku',
    baseUrl: BASE,

    async search(query, { page, limit }) {
      const qs = new URLSearchParams({ post_type: 'manga', s: query })
      if (page > 1) qs.set('paged', String(page))
      try {
        return parseList(await getHtml(`/?${qs}`)).slice(0, limit)
      } catch (e) {
        if (e instanceof NotFoundError) return []
        throw e
      }
    },

    async latest({ page, limit, type }) {
      return (await pustaka({ page, type })).slice(0, limit)
    },

    /** Genre -> endpoint API genre (slug unified dipetakan ke slug Komiku); tanpa genre -> `/pustaka/`. Status tidak didukung situs. */
    async browse(o: BrowseOptions) {
      if (!o.genre) return pustaka({ page: o.page, type: o.type })
      const g = (await komikuGenres('').catch(() => undefined))?.get(o.genre)
      if (!g) return [] // genre ini tidak dikenal Komiku
      return byGenre(g, o.page, o.type)
    },

    async listGenres() {
      return [...(await komikuGenres('')).values()].map(g => g.name)
    },

    /** ref seri = slug (`/manga/<slug>/`). */
    async detail(ref): Promise<SeriesDetail> {
      const d = parseDetail(await getHtml(`/manga/${encodeURIComponent(ref)}/`), ref)
      if (!d.chapters.length && !d.synopsis && d.title === ref) throw new NotFoundError('Komik tidak ditemukan')
      return d
    },

    /** ref chapter = `<seriesSlug>:<chapterSlug>` (chapterSlug mis. `sakamoto-days-chapter-279`). */
    async chapter(ref): Promise<ChapterContent> {
      const [series, chSlug] = splitOnce(ref)
      const { data, images, prev, next } = parseChapter(await getHtml(`/${encodeURIComponent(chSlug)}/`))
      if (!images.length) throw new UpstreamError('Gambar chapter tidak ditemukan')
      const link = (s: string) => (s && s !== chSlug ? cid(KEY, `${series}:${s}`) : null)
      return {
        id: cid(KEY, `${series}:${chSlug}`),
        seriesId: sid(KEY, series),
        number: data?.chapter != null ? String(data.chapter) : numberFromSlug(chSlug),
        images,
        prev: link(prev),
        next: link(next),
        imageHeaders: this.imageHeaders()
      }
    },

    imageHeaders: () => ({ 'user-agent': UA, referer: `${BASE}/` })
  }
}

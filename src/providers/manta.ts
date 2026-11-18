import { NotFoundError, UpstreamError } from '../core/errors.js'
import { request, retry } from '../core/http.js'
import { cid, sid } from '../core/ids.js'
import type { ChapterContent, ChapterSummary, ProviderAdapter, SeriesDetail, SeriesSummary } from '../core/types.js'
import { compact, isoDate, memo, numOrNull, splitOnce } from '../core/util.js'

const KEY = 'manta'
const BASE = 'https://manta.net'
const HOME_VERSION = '202606'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const SECTIONS: Record<string, string> = { comic: 'comics', manga: 'manga', novel: 'novels' }
const HEADERS = {
  'user-agent': UA,
  accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  origin: BASE,
  referer: `${BASE}/en`,
  'accept-language': 'en-US,en;q=0.9'
}

type Raw = Record<string, any>

const fetchBody = <T>(path: string, read: (r: Response) => Promise<T>) =>
  retry(async () => read(await request(BASE + path, { headers: HEADERS, timeoutMs: 15000 })))

const getJson = (path: string): Promise<Raw> => fetchBody(path, r => r.json())

async function pageProps(path: string): Promise<Raw> {
  const html = await fetchBody(path, r => r.text())
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)
  if (!m) throw new UpstreamError(`Data tidak ditemukan: ${path}`)
  return JSON.parse(m[1]).props?.pageProps ?? {}
}

const loc = (v: any): string => (v && typeof v === 'object' ? (v.en ?? Object.values(v)[0] ?? '') : (v ?? ''))
const tagNames = (list: any[] | undefined): string[] =>
  (list ?? []).map(t => (typeof t === 'string' ? t : loc(t.name))).filter(Boolean)

const httpUrl = (u: unknown): string => {
  const v = typeof u === 'string' ? u.trim() : ''
  if (v.startsWith('//')) return `https:${v}`
  return /^https?:\/\//i.test(v) && !/^data:/i.test(v) ? v : ''
}

const COVER_KEYS = ['1280x1840_720', '1280x1840_480', '1440x1440_720', '1440x1440_480', 'thumbnail1']

/**
 * Cover dari objek `image` Manta. Ukuran yang dikenal dicoba dulu; bila API mengirim ukuran/bentuk lain
 * (list home, search, dan detail tidak selalu memakai key yang sama) ambil ukuran portrait terdekat ke 720px,
 * agar cover tidak kosong hanya karena nama key berubah.
 */
function cover(image: Raw = {}): string {
  if (!image || typeof image !== 'object') return httpUrl(image)
  for (const k of COVER_KEYS) {
    const u = httpUrl(image[k]?.downloadUrl)
    if (u) return u
  }
  const direct = httpUrl(image.downloadUrl)
  if (direct) return direct
  const found = Object.entries(image)
    .map(([k, v]) => ({ k, u: httpUrl((v as Raw | undefined)?.downloadUrl), m: k.match(/^(\d+)x(\d+)/) }))
    .filter(x => x.u)
    .map(x => ({ u: x.u, w: x.m ? +x.m[1] : 0, portrait: x.m ? +x.m[2] > +x.m[1] : false }))
  const pool = found.some(x => x.portrait) ? found.filter(x => x.portrait) : found
  pool.sort((a, b) => Math.abs(a.w - 720) - Math.abs(b.w - 720))
  return pool[0]?.u ?? ''
}

function typeOf(n: unknown, tags: Raw[] = []): string {
  const v = Number(n ?? 0)
  if (v === 40) return 'novel'
  if (v === 50 || v === 60) return 'manga'
  return tags.some(t => t?.id === 292) ? 'novel' : 'comic'
}

const statusOf = (v: unknown): 'ongoing' | 'completed' | null => (v === true ? 'completed' : v === false ? 'ongoing' : null)

function toSummary(raw: Raw): SeriesSummary | null {
  const d: Raw = raw.data ?? {}
  const ref = String(raw.id ?? raw.seriesId ?? '')
  const title = String(loc(d.title) || raw.title || '').trim()
  if (!ref || !title) return null
  const id = sid(KEY, ref)
  const ord = raw.latestEpisode?.ord
  return {
    id,
    provider: KEY,
    title,
    cover: cover(raw.image) || cover(raw.series?.image) || httpUrl(raw.coverImage?.downloadUrl) || httpUrl(raw.thumbnail?.downloadUrl) || '',
    url: `${BASE}/en/series/${ref}`,
    type: typeOf(raw.type ?? raw.seriesType, d.tags),
    status: statusOf(d.isCompleted),
    genres: tagNames(d.tags),
    rating: null,
    chapterCount: numOrNull(raw.episodeCount ?? ord),
    latestChapter: ord != null ? String(ord) : null,
    sources: [{ provider: KEY, id }]
  }
}

interface Episode {
  id: string
  number: string
  title: string
  date: string | null
}

const episodesOf = (s: Raw): Episode[] =>
  (s.episodes ?? [])
    .map((ep: Raw) => ({
      id: String(ep.id),
      number: String(ep.ord ?? ep.id),
      title: loc(ep.data?.title) || `Episode ${ep.ord}`,
      date: isoDate(ep.openAt)
    }))
    .sort((a: Episode, b: Episode) => parseFloat(b.number) - parseFloat(a.number))

/** Data seri: API JSON `/front/v1/series/:id` dulu (lebih stabil), fallback ke __NEXT_DATA__ halaman web. */
async function loadSeries(id: string): Promise<Raw> {
  const enc = encodeURIComponent(id)
  try {
    const s = (await getJson(`/front/v1/series/${enc}`)).data
    if (s && typeof s === 'object') return s
  } catch (e) {
    if (e instanceof NotFoundError) throw e
  }
  const p = await pageProps(`/en/series/${enc}`)
  if (!p.initialSeries) throw new NotFoundError(`Series "${id}" tidak ditemukan`)
  return { ...p.initialSeries, _head: p.headData }
}

/** Dipakai detail() dan chapter(); di-memo singkat agar tidak fetch ganda. */
const seriesPage = memo(loadSeries, 30_000)

const imageUrls = (list: any[] | undefined): string[] => (list ?? []).map((x: Raw) => x?.downloadUrl).filter(Boolean)

/** Gambar episode: `cutImages` penuh dari API; bila kosong/gagal, pakai `previewCutImages` dari halaman web. */
async function loadImages(id: string): Promise<string[]> {
  const enc = encodeURIComponent(id)
  let apiOk = false
  try {
    const ep = (await getJson(`/front/v1/episodes/${enc}`)).data
    apiOk = true
    const full = imageUrls(ep?.cutImages)
    if (full.length) return full
  } catch (e) {
    if (e instanceof NotFoundError) throw e
  }
  try {
    return imageUrls((await pageProps(`/en/episodes/${enc}`)).previewCutImages)
  } catch (e) {
    if (apiOk && !(e instanceof NotFoundError)) return []
    throw e
  }
}

export function createManta(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Manta',
    baseUrl: BASE,

    async search(query, { page, limit }) {
      const res = await getJson(`/manta/v1/search/series?lang=en&q=${encodeURIComponent(query)}`)
      const items = compact<SeriesSummary>((Array.isArray(res.data) ? res.data : []).map(toSummary))
      return items.slice((page - 1) * limit, page * limit)
    },

    async latest({ page, limit, type = 'comic' }) {
      const res = await getJson(`/front/v1/home/${HOME_VERSION}?lang=en&homeType=${SECTIONS[type] || 'comics'}`)
      const map: Raw = res.data?.seriesMap ?? {}
      const items = compact<SeriesSummary>(
        (res.data?.items ?? []).map((it: Raw) => {
          const base: Raw = map[it.seriesId] ?? {}
          const merged: Raw = { ...base, ...it }
          // Item feed bisa membawa `image` sendiri (banner/ukuran lain) yang menimpa gambar seri -> cover kosong. Pakai yang punya cover.
          if (!cover(it.image) && cover(base.image)) merged.image = base.image
          return toSummary(merged)
        })
      )
      return items.slice((page - 1) * limit, page * limit)
    },

    async detail(ref): Promise<SeriesDetail> {
      const s = await seriesPage(ref)
      const head: Raw = s._head ?? {}
      const d: Raw = s.data ?? {}
      const chapters: ChapterSummary[] = episodesOf(s).map(e => ({ ...e, id: cid(KEY, `${ref}:${e.id}`) }))
      const id = sid(KEY, ref)
      return {
        id,
        provider: KEY,
        title: String(loc(d.title) || head.title || ref).trim(),
        cover: cover(s.image) || httpUrl(head.image) || '',
        url: `${BASE}/en/series/${ref}`,
        type: typeOf(s.type, d.tags),
        status: statusOf(d.isCompleted),
        genres: tagNames(d.tags),
        rating: null,
        chapterCount: chapters.length,
        latestChapter: chapters[0]?.number ?? null,
        sources: [{ provider: KEY, id }],
        synopsis: loc(d.description?.long ?? d.description?.short ?? d.description) || head.description || '',
        author: (d.creators ?? []).map((c: Raw) => c.name ?? c.creatorName).filter(Boolean).join(', '),
        artist: '',
        year: null,
        chapters
      }
    },

    /** ref chapter = `<seriesId>:<episodeId>` (episodeId < 1000 dianggap nomor chapter, seperti scraper asli). */
    async chapter(ref): Promise<ChapterContent> {
      const [seriesId, episodeId] = splitOnce(ref)
      let id = episodeId
      const chaptersP = seriesPage(seriesId).then(episodesOf, () => [] as Episode[])
      if (Number(id) < 1000) id = (await chaptersP).find(c => c.number === id)?.id ?? id
      const [images, chapters] = await Promise.all([loadImages(id), chaptersP])
      const i = chapters.findIndex(c => c.id === id)
      const link = (e?: Episode) => (e ? cid(KEY, `${seriesId}:${e.id}`) : null)
      return {
        id: cid(KEY, `${seriesId}:${id}`),
        seriesId: sid(KEY, seriesId),
        number: i !== -1 ? chapters[i].number : id,
        images,
        prev: i !== -1 && i < chapters.length - 1 ? link(chapters[i + 1]) : null,
        next: i > 0 ? link(chapters[i - 1]) : null,
        imageHeaders: this.imageHeaders()
      }
    },

    imageHeaders: () => ({ 'user-agent': UA, referer: `${BASE}/en` })
  }
}

import { NotFoundError, UpstreamError } from '../core/errors.js'
import { request, retry } from '../core/http.js'
import { cid, sid } from '../core/ids.js'
import type { ChapterContent, ProviderAdapter, SeriesDetail, SeriesStatus, SeriesSummary } from '../core/types.js'
import { compact, isoDate, numOrNull } from '../core/util.js'

const KEY = 'shinigami'
// Situs & API pindah ke domain baru (s1.shinigami.mx / api.shinigami.io). Bisa diganti lewat env bila pindah lagi tanpa ubah kode.
const BASE = (process.env.SHINIGAMI_BASE_URL || 'https://s1.shinigami.mx').replace(/\/+$/, '')
const API = (process.env.SHINIGAMI_API_URL || 'https://api.shinigami.io').replace(/\/+$/, '')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, origin: BASE, referer: `${BASE}/`, accept: 'application/json' }
// Entri pengumuman milik situs, bukan komik.
const HIDDEN_TITLES = new Set(['shinigami news'])
const FORMATS = new Set(['manga', 'manhwa', 'manhua'])

type Raw = Record<string, any>

const api = (path: string): Promise<Raw> =>
  retry(async () => {
    const res = await request(API + path, { headers: HEADERS, timeoutMs: 15000 })
    const json: Raw = await res.json()
    if (json.retcode !== undefined && json.retcode !== 0) throw new UpstreamError(json.message || 'API error')
    return json
  })

const names = (list: unknown): string[] =>
  Array.isArray(list) ? list.map(x => x?.name).filter(Boolean) : []
const statusOf = (s: number): SeriesStatus => (({ 1: 'ongoing', 2: 'hiatus' }) as Record<number, SeriesStatus>)[s] || 'completed'

function toSummary(m: Raw): SeriesSummary | null {
  if (!m?.manga_id || !m.title || HIDDEN_TITLES.has(String(m.title).trim().toLowerCase())) return null
  const id = sid(KEY, m.manga_id)
  return {
    id,
    provider: KEY,
    title: m.title,
    cover: m.cover_portrait_url || m.cover_image_url || '',
    url: `${BASE}/series/${m.manga_id}/`,
    type: names(m.taxonomy?.Type)[0]?.toLowerCase() ?? null,
    status: statusOf(m.status),
    genres: names(m.taxonomy?.Genre),
    rating: null,
    chapterCount: null,
    latestChapter: m.latest_chapter_number != null ? String(m.latest_chapter_number) : null,
    sources: [{ provider: KEY, id }]
  }
}

async function list(q: string, page: number, size: number, type?: string): Promise<SeriesSummary[]> {
  const qs = new URLSearchParams({ page: String(page), page_size: String(size), sort: 'latest', sort_order: 'desc' })
  if (q) qs.set('q', q)
  // Tanpa kata kunci = "terbaru": hanya seri yang baru update, seperti halaman utama situs.
  else qs.set('is_update', 'true')
  if (type && FORMATS.has(type.toLowerCase())) qs.set('format', type.toLowerCase())
  const res = await api(`/v1/manga/list?${qs}`)
  return compact((res.data ?? []).map(toSummary))
}

const PAGE_SIZE = 100
const BATCH = 6
const MAX_PAGES = 120

async function chapterList(id: string) {
  const fetchPage = (n: number) =>
    api(`/v1/chapter/${id}/list?${new URLSearchParams({ page: String(n), page_size: String(PAGE_SIZE), sort_by: 'chapter_number', sort_order: 'desc' })}`)
  const seen = new Map<string, Raw>()
  const add = (r: Raw | null) => {
    let fresh = 0
    for (const c of r?.data ?? []) {
      const key = c?.chapter_id ? String(c.chapter_id) : ''
      if (key && !seen.has(key)) { seen.set(key, c); fresh++ }
    }
    return fresh
  }
  const first = await fetchPage(1)
  add(first)
  const perPage = (first.data ?? []).length
  const meta: Raw = first.meta ?? {}
  const total = Number(meta.total_record ?? meta.total_data ?? meta.total_items ?? meta.total) || 0
  const hint = Math.max(Number(meta.total_page ?? meta.total_pages) || 1, perPage && total ? Math.ceil(total / perPage) : 1)
  for (let n = 2; n <= MAX_PAGES && perPage > 0; ) {
    const size = n <= hint ? Math.min(BATCH, hint - n + 1, MAX_PAGES - n + 1) : 1
    const pages = Array.from({ length: size }, (_, i) => n + i)
    const res = await Promise.all(pages.map(p => fetchPage(p).catch(e => { if (p <= hint) throw e; return null })))
    const fresh = res.reduce((sum, r) => sum + add(r), 0)
    n += size
    if (n > hint && fresh === 0) break
  }
  return [...seen.values()]
    .map((c: Raw) => ({
      id: cid(KEY, c.chapter_id),
      number: String(c.chapter_number ?? ''),
      title: c.chapter_title || '',
      date: isoDate(c.release_date || c.created_at)
    }))
    .sort((a, b) => parseFloat(b.number) - parseFloat(a.number))
}

export function createShinigami(): ProviderAdapter {
  return {
    key: KEY,
    name: 'Shinigami',
    baseUrl: BASE,

    search: (q, { page, limit }) => list(q, page, limit),
    latest: ({ page, limit, type }) => list('', page, limit, type),

    async detail(ref): Promise<SeriesDetail> {
      const [res, chapters] = await Promise.all([api(`/v1/manga/detail/${ref}`), chapterList(ref)])
      const d: Raw | undefined = res.data
      if (!d) throw new NotFoundError('Manga tidak ditemukan')
      const base = toSummary({ ...d, manga_id: d.manga_id ?? ref })
      if (!base) throw new NotFoundError('Manga tidak ditemukan')
      return {
        ...base,
        chapterCount: numOrNull(chapters.length),
        latestChapter: base.latestChapter ?? chapters[0]?.number ?? null,
        synopsis: d.description || '',
        author: names(d.taxonomy?.Author).join(', '),
        artist: names(d.taxonomy?.Artist).join(', '),
        year: numOrNull(d.release_year),
        chapters
      }
    },

    async chapter(ref): Promise<ChapterContent> {
      const d: Raw | undefined = (await api(`/v1/chapter/detail/${ref}`)).data
      if (!d) throw new NotFoundError('Chapter tidak ditemukan')
      const ch: Raw = d.chapter || {}
      const root = d.base_url || ch.base_url || ''
      const join = (...p: unknown[]) =>
        p
          .map(s => String(s || '').replace(/^\/+|\/+$/g, ''))
          .filter(Boolean)
          .join('/')
      return {
        id: cid(KEY, d.chapter_id || ref),
        seriesId: d.manga_id ? sid(KEY, d.manga_id) : null,
        number: String(d.chapter_number ?? ''),
        images: (ch.data ?? []).map((f: string) => (/^https?:\/\//.test(f) ? f : join(root, ch.path, f))),
        prev: d.prev_chapter_id ? cid(KEY, d.prev_chapter_id) : null,
        next: d.next_chapter_id ? cid(KEY, d.next_chapter_id) : null,
        imageHeaders: this.imageHeaders()
      }
    },

    imageHeaders: () => ({ 'user-agent': UA, referer: `${BASE}/`, origin: BASE })
  }
}

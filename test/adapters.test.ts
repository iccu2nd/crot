/** Adapter diuji dengan fetch ter-mock; bentuk payload mengikuti field yang dibaca scraper asli. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createKiryuu } from '../src/providers/kiryuu.js'
import { createLumos } from '../src/providers/lumos.js'
import { createShinigami } from '../src/providers/shinigami.js'
import { mockFetch } from './helpers.js'

describe('shinigami', () => {
  const manga = { manga_id: 'abc', title: 'Shini', status: 1, cover_portrait_url: 'p.jpg', latest_chapter_number: 12, taxonomy: { Type: [{ name: 'Manhwa' }], Genre: [{ name: 'Drama' }], Author: [{ name: 'Au' }] } }

  it('search/latest/detail (chapter list multi-halaman)/chapter', async () => {
    const m = mockFetch({
      '/v1/manga/list': () => ({ json: { retcode: 0, data: [manga, { manga_id: '', title: 'x' }, { manga_id: 'n1', title: 'Shinigami News' }] } }),
      '/v1/manga/detail/abc': () => ({ json: { retcode: 0, data: { ...manga, description: 'desc', release_year: 2021 } } }),
      'cursor=cur2': () => ({ json: { retcode: 0, meta: { has_next: false }, data: [{ chapter_id: 'c2', chapter_number: 2 }] } }),
      'sort_order=asc': () => ({ json: { retcode: 0, meta: { has_next: false }, data: [{ chapter_id: 'c1', chapter_number: 1, release_date: '2024-02-01T00:00:00Z' }] } }),
      'limit=100': () => ({ json: { retcode: 0, meta: { has_next: true, next_cursor: 'cur2' }, data: [{ chapter_id: 'c1', chapter_number: 1, release_date: '2024-02-01T00:00:00Z' }] } }),
      '/v1/chapter/detail/c2': () => ({ json: { retcode: 0, data: { chapter_id: 'c2', manga_id: 'abc', chapter_number: 2, prev_chapter_id: 'c1', chapter: { base_url: 'https://cdn/', path: '/p/', data: ['1.jpg', 'https://o/2.jpg'] } } } })
    })
    try {
      const a = createShinigami()
      const found = await a.search('shini', { page: 1, limit: 10 })
      const [s] = found
      assert.equal(s.id, 'shinigami:abc')
      assert.equal(found.length, 1) // 'Shinigami News' & id kosong disaring
      assert.equal(s.type, 'manhwa')
      assert.equal(s.status, 'ongoing')
      assert.equal(s.latestChapter, '12')
      assert.ok(m.calls[0].startsWith('https://api.shinigami.io/v1/manga/list'))
      assert.ok(m.calls[0].includes('q=shini') && m.calls[0].includes('page_size=30')) // minimal 30 per halaman agar hasil tidak sedikit
      assert.equal((await a.latest({ page: 1, limit: 10, type: 'manhwa' })).length, 1)
      assert.ok(m.calls[1].includes('is_update=true') && m.calls[1].includes('format=manhwa') && !m.calls[1].includes('q='))
      const d = await a.detail('abc')
      assert.deepEqual(d.chapters.map(c => c.id), ['shinigami:c2', 'shinigami:c1'])
      assert.equal(d.synopsis, 'desc')
      assert.equal(d.year, 2021)
      assert.equal(d.chapterCount, 2)
      const ch = await a.chapter('c2')
      assert.deepEqual(ch.images, ['https://cdn/p/1.jpg', 'https://o/2.jpg'])
      assert.equal(ch.seriesId, 'shinigami:abc')
      assert.equal(ch.prev, 'shinigami:c1')
      assert.equal(ch.next, null)
    } finally { m.restore() }
  })

  it('chapter list: limit=100, ikuti cursor desc + asc lalu digabung', async () => {
    const row = (n: number) => ({ chapter_id: `c${n}`, chapter_number: n })
    const m = mockFetch({
      '/v1/manga/detail/abc': () => ({ json: { retcode: 0, data: { ...manga } } }),
      'cursor=k2': () => ({ json: { retcode: 0, meta: { has_next: false }, data: [row(1), row(2)] } }),
      'cursor=k1': () => ({ json: { retcode: 0, meta: { has_next: true, next_cursor: 'k2' }, data: [row(3), row(4), row(5)] } }),
      'sort_order=asc': () => ({ json: { retcode: 0, meta: { has_next: false }, data: [row(1), row(2)] } }),
      'limit=100': () => ({ json: { retcode: 0, meta: { has_next: true, next_cursor: 'k1' }, data: [row(6), row(7), row(8)] } })
    })
    try {
      const d = await createShinigami().detail('abc')
      assert.deepEqual(d.chapters.map(c => c.number), ['8', '7', '6', '5', '4', '3', '2', '1'])
      assert.ok(m.calls.some(u => u.includes('/chapter/abc/list') && u.includes('limit=100')))
      assert.ok(!m.calls.some(u => u.includes('page_size')))
    } finally { m.restore() }
  })

  it('retcode != 0 -> error (setelah retry)', async () => {
    const m = mockFetch({ '/v1/manga/list': () => ({ json: { retcode: 5, message: 'bad' } }) })
    try {
      await assert.rejects(createShinigami().latest({ page: 1, limit: 5 }), /bad/)
      assert.equal(m.calls.length, 3)
    } finally { m.restore() }
  })
})

describe('lumos (parser mengikuti scraper terbaru)', () => {
  const b64 = (u: string) => Buffer.from(u).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  it('latest, search (+fallback), rotasi mirror, thumbnail base64', async () => {
    let first = true
    const m = mockFetch({
      '/api/home-latest': () => (first ? ((first = false), { status: 500 }) : { json: { data: { items: [{ slug: 's1', title: 'Lumos T', coverImage: `/api/image/thumbnail?src=${b64('https://cdn.x/c.webp')}`, type: 'Manhwa', status: 'Ongoing', rating: '4.5', recentChapters: [{ number: 3 }, { number: 10 }] }] } } }),
      '/api/search': () => ({ json: { results: [{ slug: 's1', title: 'Lumos T' }, { title: 'tanpa slug' }] } })
    })
    try {
      const a = createLumos()
      const [i] = await a.latest({ page: 1, limit: 10 })
      assert.ok(m.calls[1].startsWith('https://02.lumosgg.com'), 'mirror berikutnya dipakai')
      assert.equal(i.id, 'lumos:s1')
      assert.equal(i.latestChapter, '10')
      assert.equal(i.type, 'manhwa')
      assert.equal(i.status, 'ongoing')
      assert.equal(i.cover, 'https://cdn.x/c.webp')
      assert.equal((await a.search('lumos', { page: 1, limit: 10 })).length, 1)
    } finally { m.restore() }
  })

  const browseHtml = `<div id="bf"><label data-bf-genre-name="slice of life">Slice of Life</label><label data-bf-genre-name="sci-fi">Sci-Fi</label></div>`
  const cards = `<div class="htg-card x"><a href="/comic/abc"><h3>Judul &amp; A</h3></a><img src="/c/abc.jpg"><svg></svg> 4.7 </span><span class="capitalize">Ongoing</span><span class="text-surface-300"> 25</span></div>
    <div class="htg-card x"><a href="/comic/def"><h3>B</h3></a></div>`

  it('browse: genre/sort/type dipetakan ke query Lumos & kartu diparse', async () => {
    const m = mockFetch({ '/browse?sort=': () => ({ text: cards }), '/browse?page=': () => ({ text: cards }), '/browse': () => ({ text: browseHtml }) })
    try {
      const a = createLumos()
      const items = await a.browse!({ page: 2, sort: 'popular', genre: 'sci-fi', type: 'manhwa', status: 'ongoing' })
      const url = m.calls.at(-1)!
      assert.ok(url.includes('page=2') && url.includes('sort=popular') && url.includes('type=manhwa') && url.includes('status=ongoing') && url.includes('genre=sci-fi'), url)
      assert.equal(items.length, 2)
      assert.deepEqual([items[0].id, items[0].title, items[0].rating, items[0].status, items[0].chapterCount], ['lumos:abc', 'Judul & A', 4.7, 'ongoing', 25])
      assert.deepEqual(items[0].genres, ['Sci-Fi'])
      assert.equal(items[0].type, 'manhwa')
      assert.deepEqual(await a.browse!({ page: 1, sort: 'latest', genre: 'tidak-ada' }), [])
      assert.deepEqual(await a.listGenres!(), ['Slice of Life', 'Sci-Fi'])
      assert.ok((await a.browse!({ page: 1, sort: 'latest', genre: 'slice-of-life' })).length)
      assert.ok(m.calls.at(-1)!.includes('genre=slice+of+life'))
    } finally { m.restore() }
  })

  it('detail & chapter dari HTML', async () => {
    const detailHtml = `<html><h1>Lumos T</h1><div>Status</div><span class="capitalize">Ongoing</span><div>Type</div><div class="text-sm">Manhwa</div>
      <a href="/browse?genre=action">Action</a><a href="/browse?genre=boys'%20love">Boys&#39; Love</a><span class="rating-value">4.2</span>
      <a href="/read/s1/chapter-2" class="x" data-chapter="2"><span class="text-heading">Judul</span></a>
      <a href="/read/s1/chapter-10" class="x" data-chapter="10">x</a><a href="/read/other/chapter-99" data-chapter="99">x</a>
      <div data-sr="${Buffer.from('Sinopsis').toString('base64')}"></div></html>`
    const readHtml = `<script>const chapterNumber = "10";</script>
      <img alt="Page 2" src="/file/comic/s1/10/2.jpg"><img src="/file/comic/s1/10/1.jpg" alt="Page 1">
      <a href="/read/s1/chapter-9">‹ Prev</a><a href="/read/s1/chapter-11">Next ›</a><a href="/read/s1/chapter-3">Chapter 3</a>`
    const m = mockFetch({ '/comic/s1': () => ({ text: detailHtml }), '/read/s1/chapter-10': () => ({ text: readHtml }) })
    try {
      const a = createLumos()
      const d = await a.detail('s1')
      assert.deepEqual(d.chapters.map(c => c.number), ['10', '2'])
      assert.equal(d.chapters[0].id, 'lumos:s1:chapter-10')
      assert.equal(d.chapters[1].title, 'Judul')
      assert.deepEqual(d.genres, ['Action', "Boys' Love"])
      assert.equal(d.synopsis, 'Sinopsis')
      assert.equal(d.rating, 4.2)
      assert.equal(d.status, 'ongoing')
      assert.equal(d.type, 'manhwa')
      const ch = await a.chapter('s1:chapter-10')
      assert.equal(ch.images.length, 2)
      assert.ok(ch.images[0].endsWith('/1.jpg'), 'urut halaman')
      assert.equal(ch.prev, 'lumos:s1:chapter-9')
      assert.equal(ch.next, 'lumos:s1:chapter-11')
      assert.equal(ch.number, '10')
    } finally { m.restore() }
  })
})

describe('lumos (ketahanan: mirror lambat/diblokir)', () => {
  /** fetch palsu per-host: handler boleh menggantung (hormati abort) atau membalas. */
  function hostFetch(h: Record<string, (url: string, signal?: AbortSignal | null) => Promise<Response> | Response>) {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      calls.push(url)
      const host = Object.keys(h).find(k => url.startsWith(k))
      if (!host) return new Response('no route', { status: 599 })
      return h[host](url, init?.signal)
    }) as typeof fetch
    return { calls, restore: () => void (globalThis.fetch = original) }
  }
  const hang = (_u: string, signal?: AbortSignal | null) =>
    new Promise<Response>((_, rej) => signal?.addEventListener('abort', () => rej(signal.reason ?? new DOMException('Aborted', 'AbortError'))))
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
  const items = { results: [{ slug: 's1', title: 'Lumos T' }] }

  it('mirror pertama menggantung -> mirror kedua menjawab dalam < 4 detik', async () => {
    const m = hostFetch({ 'https://03.lumosgg.com': hang, 'https://02.lumosgg.com': () => json(items) })
    try {
      const t0 = Date.now()
      const r = await createLumos().search('x', { page: 1, limit: 5 })
      assert.equal(r.length, 1)
      assert.ok(Date.now() - t0 < 4000, 'tidak menunggu timeout mirror pertama')
    } finally { m.restore() }
  })

  it('halaman tantangan Cloudflare (200) dianggap gagal -> pindah mirror', async () => {
    const m = hostFetch({
      'https://03.lumosgg.com': () => new Response('<html><title>Just a moment...</title></html>', { status: 200 }),
      'https://02.lumosgg.com': () => json(items)
    })
    try {
      assert.equal((await createLumos().search('x', { page: 1, limit: 5 })).length, 1)
    } finally { m.restore() }
  })

  it('API search mati -> cadangan katalog /browse', async () => {
    const card = '<div class="htg-card"><a href="/comic/abc"><h3>Judul</h3></a></div>'
    const m = hostFetch({ 'https://': url => (url.includes('/api/') ? new Response('x', { status: 403 }) : new Response(card, { status: 200 })) })
    try {
      const r = await createLumos().search('judul', { page: 1, limit: 5 })
      assert.deepEqual(r.map(x => x.id), ['lumos:abc'])
    } finally { m.restore() }
  })

  it('semua mirror gagal -> error menyebut penyebab per mirror (bukan timeout samar)', async () => {
    const m = hostFetch({ 'https://': () => new Response('forbidden', { status: 403 }) })
    try {
      await assert.rejects(createLumos().latest({ page: 1, limit: 5 }), (e: any) => {
        assert.equal(e.status, 502)
        assert.match(e.message, /03\.lumosgg\.com: HTTP 403/)
        return true
      })
    } finally { m.restore() }
  })

  it('404 di semua mirror = NotFound (bukan 502)', async () => {
    const m = hostFetch({ 'https://': () => new Response('nope', { status: 404 }) })
    try {
      await assert.rejects(createLumos().detail('tidak-ada'), (e: any) => e.status === 404)
    } finally { m.restore() }
  })
})

describe('shinigami catalog', () => {
  it('catalog: seluruh katalog (tanpa is_update / q) untuk crawler', async () => {
    const m = mockFetch({ '/v1/manga/list': () => ({ json: { retcode: 0, data: [{ manga_id: 'a', title: 'A', status: 1, taxonomy: { Genre: [{ name: 'Action' }] } }] } }) })
    try {
      const r = await createShinigami().catalog!({ page: 3, size: 50 })
      assert.deepEqual([r[0].id, r[0].genres], ['shinigami:a', ['Action']])
      assert.ok(m.calls[0].includes('page=3') && m.calls[0].includes('page_size=50') && !m.calls[0].includes('is_update') && !m.calls[0].includes('q='))
    } finally { m.restore() }
  })
})

describe('kiryuu (scraping HTML)', () => {
  const B = 'https://v7.kiryuu.to'
  const card = (slug: string, title: string) => `<a href="${B}/manga/${slug}/" class="flex"><img src="${B}/wp-content/uploads/${slug}.png" alt="${title}"><div><h3>${title}</h3><p>Sinopsis ${title}</p></div></a>`
  const home = `<html><script>hx-post="${B}/wp-admin/admin-ajax.php?nonce=26aeda56eb&#038;action=search"</script>
    <a href="${B}/manga/popular-x/"><img src="${B}/p.png"><h3>Popular X</h3></a>
    <div><a href="${B}/manga/solo-leveling/"><img data-src="${B}/c.png" src="data:image/gif;base64,AAAA"><h3>Solo Leveling</h3></a>
    <a href="${B}/manga/solo-leveling/chapter-179.6.425255/">Chapter 179.6</a><a href="${B}/manga/solo-leveling/chapter-12.1111111/">Chapter 12</a></div></html>`
  const detailHtml = `<html><head><meta property="og:image" content="${B}/wp-content/uploads/cover.png"></head><body>
    <img src="https://secure.gravatar.com/avatar/?s=96&amp;d=mm"><h1>Solo Leveling</h1>
    <div><span>Status</span><span>Ongoing</span></div><div><span>Type</span><span>Manhwa</span></div><div><span>Author</span><span>Chugong</span></div><div>Released: 2018</div>
    <h2>Synopsis</h2><p>E-class hunter Jinwoo Sung is the weakest.</p><p>Second paragraph.</p><h2>Chapters</h2>
    <a href="${B}/genre/action/">Action</a><a href="${B}/genre/fantasy/">Fantasy</a>
    <a href="${B}/manga/solo-leveling/chapter-179.6.425255/"><span>Chapter 179.6</span><span>1 year ago</span></a>
    <a href="${B}/manga/solo-leveling/chapter-0.147843/"><span>Chapter 0</span><time datetime="2021-06-01T00:00:00Z">x</time></a>
    <a href="${B}/manga/solo-leveling/chapter-0.147843/">Baca Pertama</a>
    <a href="${B}/manga/other/chapter-1.999999/">Chapter 1</a><a href="${B}/advanced-search/">Manga Lists</a></body></html>`
  const reader = `<html><link rel="next" href="${B}/manga/solo-leveling/chapter-2.200002/">
    <a href="${B}/manga/solo-leveling/chapter-0.147843/#">Prev</a><a href="${B}/manga/solo-leveling/chapter-0.147843/">Chapter 0</a>
    <img src="https://cdn.kiryuu.io/kuma/solo-leveling/chapter-01/1.jpg"><img data-src="https://cdn.kiryuu.io/kuma/solo-leveling/chapter-01/2.jpg" src="x.gif">
    <img src="${B}/wp-content/uploads/rekomendasi.png"><img alt="Kiryuu ID" src="https://blogger.googleusercontent.com/img/ad.jpeg"></html>`

  const nonceForm = `<input type="hidden" name="search_nonce" value="abc123def4"><input name="x" value="y">`

  it('search: modal + katalog advanced_search (2 halaman upstream) + /?s= digabung, tanpa duplikat, widget disaring', async () => {
    const m = mockFetch({
      'action=get_nonce': () => ({ text: nonceForm }),
      'action=advanced_search': () => ({ text: `${card('solo-leveling', 'Solo Leveling')}${card('solo-farming', 'Solo Farming')}${card('solo-necromancer', 'Solo Necromancer')}` }),
      'action=search': () => ({ text: `<div id="searchResults">${card('solo-leveling', 'Solo Leveling')}${card('solo-necromancer', 'Solo Necromancer')}</div>` }),
      '/?s=solo': () => ({ text: `${card('solo-leveling', 'Solo Leveling')}${card('solo-max-level-newbie', 'Solo Max-Level Newbie')}${card('unrelated', 'Widget Populer')}` }),
      [`${B}/`]: () => ({ text: home })
    })
    try {
      const r = await createKiryuu().search('solo', { page: 1, limit: 10 })
      assert.deepEqual(r.map(x => x.id), ['kiryuu:solo-leveling', 'kiryuu:solo-necromancer', 'kiryuu:solo-farming', 'kiryuu:solo-max-level-newbie'])
      assert.equal(r[0].title, 'Solo Leveling')
      assert.equal(r[0].cover, `${B}/wp-content/uploads/solo-leveling.png`)
      assert.ok(m.calls.some(u => u.includes('nonce=26aeda56eb&action=search')))
      assert.ok(m.calls.some(u => u.includes('/?s=solo')))
      assert.equal(m.calls.filter(u => u.includes('action=advanced_search')).length, 2) // halaman upstream 1 & 2
      assert.equal(m.calls.filter(u => u.includes('action=get_nonce')).length, 1) // nonce dipakai bersama
    } finally { m.restore() }
  })

  it('search halaman 2 -> halaman upstream 3 & 4; nonce ditolak (balasan "0") diperbarui sekali', async () => {
    let n = 0
    const bodies: FormData[] = []
    const orig = globalThis.fetch
    const m = mockFetch({ 'action=get_nonce': () => ({ text: nonceForm }), '/?s=solo&': () => ({ text: '' }), '/?s=solo': () => ({ text: '' }) })
    const base = globalThis.fetch
    globalThis.fetch = (async (input: any, init: any) => {
      if (String(input).includes('action=advanced_search')) {
        bodies.push(init.body as FormData)
        return new Response(n++ === 0 ? '0' : card('solo-farming', 'Solo Farming'), { status: 200 })
      }
      return base(input, init)
    }) as typeof fetch
    try {
      const r = await createKiryuu().search('solo', { page: 2, limit: 10 })
      assert.deepEqual(r.map(x => x.id), ['kiryuu:solo-farming'])
      const pages = bodies.map(b => b.get('page')).sort()
      assert.ok(pages.includes('3') && pages.includes('4'))
      assert.equal(bodies[0].get('query'), 'solo')
      assert.equal(bodies[0].get('genre'), '[]')
      assert.equal(bodies[0].get('nonce'), 'abc123def4')
      assert.ok(m.calls.some(u => u.includes('action=get_nonce'))) // dipaksa ambil ulang setelah balasan "0"
    } finally { globalThis.fetch = orig; m.restore() }
  })

  it('search: advanced_search gagal -> tetap ada hasil dari modal / WP', async () => {
    const m = mockFetch({
      'action=advanced_search': () => ({ status: 500 }),
      'action=get_nonce': () => ({ status: 500 }),
      'action=search': () => ({ text: card('solo-leveling', 'Solo Leveling') }),
      '/?s=solo': () => ({ text: '' }),
      [`${B}/`]: () => ({ text: home })
    })
    try {
      const r = await createKiryuu().search('solo', { page: 1, limit: 10 })
      assert.deepEqual(r.map(x => x.id), ['kiryuu:solo-leveling'])
    } finally { m.restore() }
  })

  it('browse + listGenres: filter genre/tipe/status/sortir lewat advanced_search', async () => {
    const terms = { genre: [{ name: 'Action', slug: 'action' }, { name: '4-Koma', slug: '4-koma' }], type: [], status: [] }
    const bodies: FormData[] = []
    const orig = globalThis.fetch
    const m = mockFetch({ 'action=get_nonce': () => ({ text: nonceForm }), '/advanced-search/': () => ({ text: `<script>var searchTerms = ${JSON.stringify(terms)};</script>` }) })
    const base = globalThis.fetch
    globalThis.fetch = (async (input: any, init: any) => {
      if (String(input).includes('action=advanced_search')) {
        bodies.push(init.body as FormData)
        return new Response(card('solo-leveling', 'Solo Leveling'), { status: 200 })
      }
      return base(input, init)
    }) as typeof fetch
    try {
      const a = createKiryuu()
      assert.deepEqual(await a.listGenres!(), ['Action', '4-Koma'])
      const r = await a.browse!({ page: 2, sort: 'az', genre: '4-koma', type: 'manhwa', status: 'hiatus' })
      assert.equal(r[0].id, 'kiryuu:solo-leveling')
      assert.deepEqual([r[0].type, r[0].status, r[0].genres], ['manhwa', 'hiatus', ['4-Koma']])
      const b = bodies[0]
      assert.deepEqual([b.get('page'), b.get('genre'), b.get('type'), b.get('status'), b.get('orderby'), b.get('order')], ['2', '["4-koma"]', '["manhwa"]', '["on-hiatus"]', 'title', 'asc'])
      assert.deepEqual(await a.browse!({ page: 1, sort: 'latest', genre: 'tidak-ada' }), [])
    } finally { globalThis.fetch = orig; m.restore() }
  })

  it('latest: kartu dengan link chapter diutamakan + chapter terbaru; halaman 2 dari katalog updated', async () => {
    const m = mockFetch({
      'action=get_nonce': () => ({ text: nonceForm }),
      'action=advanced_search': () => ({ text: card('page-two', 'Page Two') }),
      [`${B}/`]: () => ({ text: home })
    })
    try {
      const r = await createKiryuu().latest({ page: 1, limit: 10 })
      assert.deepEqual(r.map(x => [x.id, x.latestChapter, x.cover]), [['kiryuu:solo-leveling', '179.6', `${B}/c.png`]])
      assert.deepEqual((await createKiryuu().latest({ page: 2, limit: 10 })).map(x => x.id), ['kiryuu:page-two'])
    } finally { m.restore() }
  })

  it('detail: metadata, sinopsis, genre, chapter (angka/tanggal/dedupe), tanpa gravatar', async () => {
    const m = mockFetch({ '/manga/solo-leveling/': () => ({ text: detailHtml }) })
    try {
      const d = await createKiryuu().detail('solo-leveling')
      assert.equal(d.title, 'Solo Leveling')
      assert.equal(d.cover, `${B}/wp-content/uploads/cover.png`)
      assert.equal(d.status, 'ongoing')
      assert.equal(d.type, 'manhwa')
      assert.equal(d.author, 'Chugong')
      assert.equal(d.year, 2018)
      assert.deepEqual(d.genres, ['Action', 'Fantasy'])
      assert.match(d.synopsis, /^E-class hunter Jinwoo Sung is the weakest\.\nSecond paragraph\.$/)
      assert.deepEqual(d.chapters.map(c => [c.id, c.number, c.title]), [['kiryuu:solo-leveling:chapter-179.6.425255', '179.6', ''], ['kiryuu:solo-leveling:chapter-0.147843', '0', '']])
      assert.ok(d.chapters[0].date && Date.parse(d.chapters[0].date) < Date.now())
      assert.equal(d.chapters[1].date, '2021-06-01T00:00:00.000Z')
      assert.equal(d.latestChapter, '179.6')
      assert.equal(d.chapterCount, 2)
    } finally { m.restore() }
  })

  it('chapter: gambar berurutan tanpa iklan/rekomendasi, prev/next dari id chapter', async () => {
    const m = mockFetch({ '/chapter-1.147943/': () => ({ text: reader }) })
    try {
      const c = await createKiryuu().chapter('solo-leveling:chapter-1.147943')
      assert.deepEqual(c.images, ['https://cdn.kiryuu.io/kuma/solo-leveling/chapter-01/1.jpg', 'https://cdn.kiryuu.io/kuma/solo-leveling/chapter-01/2.jpg'])
      assert.equal(c.id, 'kiryuu:solo-leveling:chapter-1.147943')
      assert.equal(c.seriesId, 'kiryuu:solo-leveling')
      assert.equal(c.number, '1')
      assert.equal(c.next, 'kiryuu:solo-leveling:chapter-2.200002')
      assert.equal(c.prev, 'kiryuu:solo-leveling:chapter-0.147843')
      assert.equal(c.imageHeaders.referer, `${B}/`)
    } finally { m.restore() }
  })

  it('halaman tantangan Cloudflare -> error 502 jelas, 404 -> NotFound', async () => {
    const m = mockFetch({ '/manga/x/': () => ({ text: '<html><title>Just a moment...</title></html>' }), '/manga/y/': () => ({ status: 404 }) })
    try {
      await assert.rejects(createKiryuu().detail('x'), /Cloudflare/)
      await assert.rejects(createKiryuu().detail('y'), (e: any) => e.status === 404)
    } finally { m.restore() }
  })

  it('chapter: nama file tidak berurutan / lazy-load / hanya di script tetap dapat gambar', async () => {
    const d = 'https://cdn.kiryuu.io/kuma/sex-fantasy/chapter-04'
    const lazy = `<img class="logo" src="${B}/wp-content/uploads/logo.png"><img src="https://cdn.kiryuu.io/kuma/other/chapter-01/1.jpg"><img src="https://cdn.kiryuu.io/kuma/other/chapter-01/2.jpg">` +
      ['a-01.webp', 'a-02.webp', 'a-03.webp', 'a-04.webp'].map(f => `<img src="data:image/gif;base64,R0lG" data-src="${d}/${f}" class="lazy">`).join('') + '<img src="https://cdn.kiryuu.io/kuma/ad/z.jpg">'
    const m = mockFetch({ '/chapter-4.386445/': () => ({ text: `<html>${lazy}</html>` }), '/chapter-5.1/': () => ({ text: `<html><script>var d={"images":["${d.replace(/\//g, '\\/')}\\/1.jpg","${d.replace(/\//g, '\\/')}\\/2.jpg","${d.replace(/\//g, '\\/')}\\/3.jpg"]}</script></html>` }) })
    try {
      const a = createKiryuu()
      assert.deepEqual((await a.chapter('sex-fantasy:chapter-4.386445')).images, ['a-01', 'a-02', 'a-03', 'a-04'].map(n => `${d}/${n}.webp`))
      assert.deepEqual((await a.chapter('sex-fantasy:chapter-5.1')).images, [1, 2, 3].map(n => `${d}/${n}.jpg`))
    } finally { m.restore() }
  })

  it('chapter: HTML mentah hanya og:image -> halaman ditebak berurutan dari pola CDN; alt "Page N" diurutkan', async () => {
    const dir = 'https://cdn.kiryuu.io/K/kanojo-no-tomodachi/140'
    const original = globalThis.fetch
    const probed: string[] = []
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.startsWith(dir)) {
        probed.push(url)
        const n = Number(url.match(/\/(\d+)\.jpg/)?.[1])
        return new Response('x', { status: n <= 11 ? 206 : 404, headers: { 'content-type': n <= 11 ? 'image/jpeg' : 'text/html' } })
      }
      if (url.includes('/chapter-140.847257/')) return new Response(`<html><head><meta property="og:image" content="${dir}/1.jpg"></head><body><div id="reader"></div></body></html>`)
      if (url.includes('/chapter-141.1/')) return new Response(`<html><img src="${dir}/2.jpg" alt="Kanojo - Page 2"><img src="${dir}/1.jpg" alt="Kanojo - Page 1"><img src="${dir}/3.jpg" alt="Kanojo - Page 3"></html>`)
      return new Response('no route', { status: 599 })
    }) as typeof fetch
    try {
      const a = createKiryuu()
      const c = await a.chapter('kanojo-no-tomodachi:chapter-140.847257')
      assert.deepEqual(c.images, Array.from({ length: 11 }, (_, i) => `${dir}/${i + 1}.jpg`))
      assert.equal(c.number, '140')
      const before = probed.length
      assert.deepEqual((await a.chapter('kanojo-no-tomodachi:chapter-141.1')).images, [1, 2, 3].map(n => `${dir}/${n}.jpg`))
      assert.equal(probed.length, before, 'alt Page N cukup, tanpa probing')
    } finally { globalThis.fetch = original }
  })
})

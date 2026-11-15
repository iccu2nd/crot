# Unified Scraper API

Satu REST API (Node.js + TypeScript + Fastify) untuk tiga provider: **Shinigami**, **Manta**, **Lumos**.
Format data seragam, fallback otomatis antar provider, cache Redis (stale-while-revalidate), PostgreSQL sebagai data utama.

## Jalankan
```bash
docker compose up --build          # API di :3000, dokumentasi di /docs
# atau lokal:
cp .env.example .env && npm install && npm run build && npm start
```
Migration otomatis saat start, atau manual `npm run migrate`. Env wajib hanya `DATABASE_URL` dan `REDIS_URL`; `ADMIN_TOKEN` opsional (mengaktifkan endpoint admin pengumuman). Pengaturan lain (TTL, rate limit, prioritas provider) ada di `src/config.ts`.

**Verifikasi scraper ke situs asli (wajib dijalankan sekali di jaringan Anda):**
```bash
npm run smoke            # semua provider
npm run smoke manta      # satu provider
```
Alur: latest → search → detail → chapter, lengkap dengan waktu & jumlah data; exit code 1 jika ada yang gagal.

Tes: `npm test` (unit). Tes integrasi DB: `TEST_DATABASE_URL=postgres://.../scraper_test npm test`.

## Deploy ke Vercel (serverless)
Vercel tidak menjalankan server permanen, jadi proyek memakai `api/index.js` + `vercel.json` dan mode serverless otomatis (`VERCEL=1`):
tanpa timer latar/warmer, penulisan DB dilakukan inline, tanpa migrate saat runtime.

1. Siapkan **PostgreSQL terkelola** (Neon / Supabase / Vercel Postgres, pakai URL *pooled*) dan **Redis** (Upstash, URL `rediss://...`).
2. Di Vercel → Settings → Environment Variables (centang Production **dan Build**): `DATABASE_URL` (akhiri `?sslmode=require`) dan `REDIS_URL`. Opsional: `ADMIN_TOKEN` untuk mengelola pengumuman.
3. Deploy. Build menjalankan `npm run build && npm run migrate` (migration otomatis saat deploy).
4. Buka `/docs`. Jika masih 500, lihat `vercel logs <request-id>`; penyebab tersering: `DATABASE_URL`/`REDIS_URL` belum diisi atau salah.

Catatan: cold start sedikit lebih lambat (koneksi DB/Redis). Untuk performa terbaik dan warmer aktif, pakai host server biasa (Railway/Render/Fly/VPS + `docker compose up`).

## Endpoint (`/v1`, dokumentasi interaktif di `/docs`)
| Endpoint | Fungsi |
|---|---|
| `GET /search?q=&page=&limit=&provider=` | cari di semua provider |
| `GET /latest?page=&limit=&provider=&type=` | update terbaru (`type` = comic/manga/novel; Manta memfilter di upstream, provider lain difilter dari tipe tiap seri) |
| `GET /popular?days=7&page=&limit=` | populer (lihat catatan) |
| `GET /genres` | daftar genre (DB + genre native Lumos) |
| `GET /genres/:slug/series?sort=&type=&status=` | seri per genre; `sort` = latest/popular/rating/az, `type` (format) = manga/manhwa/manhua/comic/novel, `status` = ongoing/completed/hiatus |
| `GET /series/:id` | detail + daftar chapter |
| `GET /series/:id/chapters` | daftar chapter |
| `GET /chapters/:id` | gambar chapter + `imageHeaders` |
| `GET /announcements` | pengumuman aktif untuk aplikasi (maks. 5, terbaru dulu) |
| `GET /providers` | status provider, circuit breaker, header gambar |
| `GET /health` | cek PostgreSQL & Redis |

**Id unified** = `<provider>:<id asli>`: `shinigami:<uuid>`, `manta:123`, `lumos:<slug>`.
Id chapter: `shinigami:<chapterId>`, `manta:<seri>:<episode>`, `lumos:<slug>:<chapter-slug>` — ambil dari `chapters[].id`.
Sukses: `{ data, meta }`. Error: `{ error: { code, message } }`.
Unduh gambar dengan header dari `imageHeaders` (referer wajib untuk provider tertentu).

## Pengumuman (untuk aplikasi MiToon)
Aplikasi menampilkan `GET /v1/announcements` di Home (`{ data: [{ id, title, body, url }] }`; bagian disembunyikan bila kosong).
Data ada di tabel `announcements` (migration `002`). Jika `ADMIN_TOKEN` diisi, tersedia endpoint admin (tidak tampil di `/docs`, dibatasi 10 request/menit):
```bash
# tambah (expiresAt opsional, ISO-8601)
curl -X POST https://API-KAMU/v1/admin/announcements -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"title":"Update 1.1","body":"Perbaikan reader","url":"https://github.com/akun/repo/releases","expiresAt":"2026-12-31T00:00:00Z"}'
# hapus
curl -X DELETE https://API-KAMU/v1/admin/announcements/1 -H "x-admin-token: $ADMIN_TOKEN"
```
Tanpa `ADMIN_TOKEN` endpoint admin tidak ada; kelola langsung lewat SQL (`INSERT INTO announcements (title, body, url) VALUES (...)`).

## Kontrak dengan aplikasi
| Layar aplikasi | Endpoint |
|---|---|
| Home › Sorotan / Populer / genre, carousel | `/latest`, `/popular`, `/genres/:slug/series`, `/popular?limit=6` |
| Home › pengumuman | `/announcements` |
| Explore (genre, urutkan, format, status) | `/genres`, `/genres/:slug/series?sort&type&status`, `/latest?type`, `/popular` |
| Cari | `/search` |
| Detail & rekomendasi | `/series/:id`, `/popular` |
| Reader | `/chapters/:id` (+ `imageHeaders`), `/providers` (header gambar) |

## Fallback
- **List (search/latest)**: semua provider dipanggil paralel dengan batas waktu; yang gagal dilewati (`meta.degraded`, `meta.providers`). Jika semuanya gagal → cache stale → data terakhir di PostgreSQL.
- **Detail/chapter**: jika provider asal gagal, dicari seri yang sama (judul ternormalisasi) di provider lain — dari DB, atau lewat search provider lain; chapter dicocokkan lewat nomor. `meta.fallback=true`, `meta.provider` = sumber sebenarnya.
- Circuit breaker per provider (5 gagal → buka 30 dtk) agar provider mati tidak memperlambat respons.

## Cache & kecepatan
Redis, stale-while-revalidate + singleflight (request bersamaan = 1 fetch upstream). TTL fresh/stale di `src/config.ts`
(detail 15 mnt/24 jam, latest 2 mnt/1 jam, search 5 mnt/1 jam, chapter 10 mnt/1 jam). Redis mati → cache dilewati, API tetap jalan.
Respons di-gzip, ber-`ETag` (304) dan `Cache-Control`. Penulisan ke PostgreSQL dilakukan di background (batch `unnest`).
Warmer berkala mengisi cache/DB dan memperkaya seri tanpa genre.

## Database (PostgreSQL)
`providers`, `series` (unik `(provider, ref)`, `norm_title`, index trigram untuk pencarian lokal), `genres` + `series_genres`,
`chapters` (unik `(series_id, ref)`), `series_views`. Connection pool (10, di Vercel 2), `statement_timeout` 8 dtk.
Migration: `migrations/*.sql` (transaksional, advisory lock).

## Lumos (parser terbaru)
Adapter Lumos mengikuti scraper terbaru: tanpa cheerio (regex ringan), thumbnail `?src=<base64>` didekode ke URL CDN,
katalog `/browse` (genre/sort/type/status) dipakai untuk `genres/:slug/series` — hasilnya langsung disimpan ke PostgreSQL beserta genrenya,
sehingga genre Lumos ikut lengkap. Sortir & filter akhir dikerjakan SQL agar konsisten lintas provider.

## Catatan jujur
- Scraper asli tidak punya fungsi *popular* dan *genre*, dan saya tidak mengarang endpoint upstream. Maka:
  **popular** = seri paling banyak dibuka lewat API ini (hit detail) dalam N hari; **genre** = dibangun dari genre seri yang pernah dilihat
  (list Shinigami/Manta memuat genre; Lumos diisi saat genre dibuka lewat `/browse` live, atau dari halaman detail oleh warmer). Keduanya makin lengkap seiring pemakaian.
- `limit` berlaku per provider; Lumos `latest` memakai ukuran halaman upstream.
- `date` chapter dinormalkan ke ISO-8601; Lumos tidak menyediakan tanggal.

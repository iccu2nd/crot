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
| Detail (info + chapter) | `/series/:id` |
| Reader | `/chapters/:id` (+ `imageHeaders`), `/providers` (header gambar) |

## Kecepatan (penyesuaian untuk MiToon)
- **Detail dari PostgreSQL saat cache kosong**: seri yang pernah dibuka tersimpan lengkap (sinopsis + chapter) di database. Jika Redis kosong (restart / TTL habis),
  `/series/:id` langsung dijawab dari PostgreSQL (`meta.source = "db"`) sementara data terbaru diambil di background. Tidak aktif di mode serverless (Vercel).
- **Daftar tidak menunggu provider paling lambat**: untuk `/latest` dan `/search`, setelah satu provider menjawab dengan data, provider lain hanya ditunggu
  `listGraceMs` (default 2500 ms, `src/config.ts`). Yang belum selesai ditandai `timeout` di `meta.providers`, tetap lanjut di background dan masuk cache,
  jadi permintaan berikutnya sudah lengkap. `listGraceMs: 0` = selalu tunggu semua provider seperti sebelumnya.
- **Prefetch chapter berikutnya**: saat `/chapters/:id` dibuka, chapter `next` diambil lebih dulu di background (`prefetchNextChapter` di `src/config.ts`) sehingga "lanjut baca" langsung dari cache.
- **View counter** tidak lagi kehilangan hit saat database sempat gagal; hit dikirim ulang pada flush berikutnya.
- Catatan VPS: Redis di `docker-compose.yml` tanpa persistensi (`--save ""`); berkat fallback PostgreSQL di atas, restart Redis tidak lagi membuat halaman detail lambat.

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


## Akun & login

Aplikasi mewajibkan login: username/email + password, atau **Masuk dengan Google**. Endpoint (`/v1/auth/*`, tampil di `/docs`): `register`, `login`, `google`, `me`, dan `config` (memberi tahu app apakah tombol Google aktif, jadi **tidak perlu build ulang APK** saat Google diaktifkan). Tabel `users` dibuat otomatis (migration `003`). Password disimpan sebagai hash scrypt; token login = JWT HS256 berlaku 90 hari. Endpoint katalog tetap publik.

Env: `JWT_SECRET` (**wajib** di produksi; `openssl rand -hex 32`) dan, opsional untuk Google:

- Isi `GOOGLE_CLIENT_ID` dengan OAuth client type *Web* (Google Cloud Console). Buat juga satu client type *Android* (package `id.mitoon.app` + SHA-1 keystore rilis APK). APK harus ditandatangani keystore yang **tetap** (secret `KEYSTORE_*` di GitHub), kalau tidak SHA-1 berubah tiap build dan Google menolak.

## Profil & komentar

Migration `004` menambah foto profil dan tabel `comments`.

- **Nama & username:** `PATCH /v1/auth/me` (body `{displayName?, username?}`). Nama tampilan bebas (maks. 30 karakter, kosong = pakai username). Username hanya bisa diganti **sekali per 7 hari** (dicek atomik di SQL; bila belum waktunya → `429 USERNAME_COOLDOWN` dengan sisa waktu). `GET /auth/me` dan respons login memuat `displayName` dan `usernameCooldownSec` (sisa detik cooldown). Migration `005`.
- **XP & level:** tiap pengguna punya `xp` dan level (`GET /auth/me` memuat `xp`, `level`, `levelXp`, `levelNeed`). Kurva: naik dari level L ke L+1 butuh `40 + 15(L-1) + (L-1)²` XP (L1→2 = 40, L10→11 = 256, L50→51 = 3.176). Sumber XP (aturan di `src/core/xp.ts`, mudah diubah): baca chapter **+10** (sekali per chapter, maks. 20/hari), komentar/balasan **+5** (maks. 10/hari), tambah pustaka **+3** (sekali per seri, maks. 5/hari), buka app harian **+5**, komentarmu disukai orang lain **+1** (maks. 20/hari). Tiap aksi dicatat di tabel `xp_events` (unik per user+jenis+ref) sehingga tidak bisa dihitung dua kali; batas harian memakai hari WIB. App melapor lewat `POST /v1/xp/event` `{type: read|bookmark|daily, ref}`; komentar & like dihitung server sendiri. Migration `006`.
- **Komentar:** balasan 1 tingkat (`POST /comments` dengan `parentId`; `GET /comments/:id/replies`), like/dislike `PUT /comments/:id/vote` `{value: 1|-1|0}`. `GET /comments` memberi `hasMore`, dan `likes/dislikes/myVote/replyCount/level` per komentar (`myVote` terisi bila request membawa token).
- **Foto profil:** `PUT /v1/auth/me/avatar` (body mentah `image/jpeg`, maks. 300 KB; app memotong persegi & mengecilkan ke 384 px sebelum upload), `DELETE /v1/auth/me/avatar`, dan `GET /v1/users/:id/avatar?v=<avatarV>` (publik, di-cache lama; `v` berubah tiap ganti foto). Foto disimpan di PostgreSQL (kolom `bytea`), jadi tidak butuh disk/S3.
- **Riwayat komentar:** `GET /v1/comments/mine?limit=&before=` (wajib login) — komentar & balasan milik akun, terbaru dulu, tiap item memuat `target` (`s:…`/`c:…`), dengan `total`/`hasMore` untuk paginasi. Migration `007` menambah indeks `(user_id, id DESC)`.
- **Hapus akun:** `DELETE /v1/auth/me?confirm=HAPUS` (wajib login; maks. 3/menit). Baris `users` dihapus; komentar, suara, dan riwayat XP ikut terhapus lewat `ON DELETE CASCADE`.
- **Komentar:** `GET /v1/comments?target=…&limit=…&before=…` (publik), `POST /v1/comments` dan `DELETE /v1/comments/:id` (wajib login; hanya penulis yang bisa menghapus). `target` = `s:<id seri>` (halaman detail) atau `c:<id chapter>` (reader). Komentar maks. 1000 karakter, kiriman dibatasi 10/menit per IP. Belum ada moderasi/balasan; hapus komentar bermasalah lewat SQL (`DELETE FROM comments WHERE id = …`).

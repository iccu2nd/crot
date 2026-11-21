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
2. Di Vercel → Settings → Environment Variables (centang Production **dan Build**): `DATABASE_URL` (akhiri `?sslmode=verify-full`, perilakunya sama dengan `require` di pg versi baru tapi tanpa peringatan) dan `REDIS_URL`. Opsional: `ADMIN_TOKEN` untuk mengelola pengumuman.
3. Deploy. Build menjalankan `npm run build && npm run migrate` (migration otomatis saat deploy).
4. Buka `/docs`. Jika masih 500, lihat `vercel logs <request-id>`; penyebab tersering: `DATABASE_URL`/`REDIS_URL` belum diisi atau salah.

Catatan: cold start sedikit lebih lambat (koneksi DB/Redis). Untuk performa terbaik dan warmer aktif, pakai host server biasa (Railway/Render/Fly/VPS + `docker compose up`).

## Endpoint (`/v1`, dokumentasi interaktif di `/docs`)
| Endpoint | Fungsi |
|---|---|
| `GET /search?q=&page=&limit=&provider=` | cari di semua provider |
| `GET /latest?page=&limit=&provider=&type=` | update terbaru (`type` = comic/manga/novel; Manta memfilter di upstream, provider lain difilter dari tipe tiap seri) |
| `GET /popular?days=7&page=&limit=` | populer (lihat catatan) |
| `GET /recommended?page=&limit=&provider=` | rekomendasi: rating tertinggi (hanya seri berating), lalu terbaru |
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
Aplikasi menampilkan `GET /v1/announcements` di Notifikasi › tab Informasi (`{ data: [{ id, title, body, url, createdAt, expiresAt }] }`), bukan di Home. `GET /v1/notifications/unread` mengembalikan `{ count, notif, info }`; `POST /v1/notifications/read?kind=notif|info|all`.
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
| Notifikasi › Informasi | `/announcements` |
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

## Perbaikan kecepatan (v25)
- **Cache L1 di memori** (`core/cache.ts`): jawaban fresh dilayani tanpa round-trip Redis & tanpa `JSON.parse` ulang. Redis hanya dipakai untuk berbagi antar-instance dan data stale.
- **Rate limit di memori**, bukan Redis: sebelumnya tiap request menunggu 1 round-trip Redis sebelum diproses.
- **Genre/Explore tidak lagi menunggu scrape live**: data PostgreSQL dilayani langsung, sinkronisasi katalog Lumos jalan di belakang (hanya ditunggu bila genre itu masih kosong di DB).
- **`/latest` saat cache kosong** langsung dari PostgreSQL (server biasa) sambil di-refresh di background.
- **Header CDN**: `s-maxage` + `stale-while-revalidate` pada list/detail/chapter, jadi di Vercel request ramai dilayani dari edge tanpa menyalakan fungsi.
- **TTL chapter** 6 jam fresh / 7 hari stale (gambar chapter hampir tidak berubah); detail stale 7 hari.
- **Cold start serverless**: Redis + sync provider paralel; swagger hanya dimuat untuk `/docs` (instance API murni lebih ringan).
- Migration `015_perf.sql`: index untuk query daftar.
- Catatan: di Vercel tiap cold start tetap membuat koneksi DB/Redis baru dan warmer tidak jalan. Untuk performa terbaik pakai Railway/VPS (satu proses hidup terus: L1, warmer, dan prefetch chapter aktif). Pastikan region fungsi/DB/Redis sama dan dekat dengan pengguna.

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

## Shinigami (domain baru)
Situs `https://s1.shinigami.mx`, API `https://api.shinigami.io/v1`. Keduanya bisa diganti lewat env `SHINIGAMI_BASE_URL` dan `SHINIGAMI_API_URL`. `latest` memakai `is_update=true` (+ `format` bila `type` diisi); entri "Shinigami News" disaring.

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
- **Bio:** `PATCH /v1/auth/me` juga menerima `bio` (maks. 150 karakter, maks. 3 baris, kosong = hapus). `bio` ikut di `GET /auth/me`, respons login, dan profil publik `GET /users/:id`. Migration `009`.
- **XP & level:** tiap pengguna punya `xp` dan level (`GET /auth/me` memuat `xp`, `level`, `levelXp`, `levelNeed`). Kurva: naik dari level L ke L+1 butuh `40 + 15(L-1) + (L-1)²` XP (L1→2 = 40, L10→11 = 256, L50→51 = 3.176). Sumber XP (aturan di `src/core/xp.ts`, mudah diubah): baca chapter **+10** (sekali per chapter, maks. 20/hari), komentar/balasan **+5** (maks. 10/hari), tambah pustaka **+3** (sekali per seri, maks. 5/hari), buka app harian **+5**, komentarmu disukai orang lain **+1** (maks. 20/hari). Tiap aksi dicatat di tabel `xp_events` (unik per user+jenis+ref) sehingga tidak bisa dihitung dua kali; batas harian memakai hari WIB. App melapor lewat `POST /v1/xp/event` `{type: read|bookmark|daily, ref}`; komentar & like dihitung server sendiri. Migration `006`.
- **Peringkat XP mingguan:** `GET /v1/xp/leaderboard?limit=50` (maks. 100) menjumlahkan XP dari `xp_events` pada minggu berjalan (Senin 00.00 WIB → Senin berikutnya; reset otomatis karena dihitung dari tanggal). Seri skor: yang lebih dulu mencapai skor di atas; akun diblokir tidak ikut. Balasan: `{weekStart, resetAt, now, total, items[{rank,id,username,displayName,avatarV,level,verified,isOwner,premium,weekXp}], me}`; `me` (posisi peminta, juga di luar `limit`) terisi bila request membawa token login. Migration `022` (indeks `xp_events(day, user_id)`).
- **Komentar:** balasan 1 tingkat (`POST /comments` dengan `parentId`; `GET /comments/:id/replies`), like/dislike `PUT /comments/:id/vote` `{value: 1|-1|0}`. `GET /comments` memberi `hasMore`, dan `likes/dislikes/myVote/replyCount/level` per komentar (`myVote` terisi bila request membawa token).
- **Foto profil:** `PUT /v1/auth/me/avatar` (body mentah `image/jpeg`, maks. 300 KB; app memotong persegi & mengecilkan ke 384 px sebelum upload), `DELETE /v1/auth/me/avatar`, dan `GET /v1/users/:id/avatar?v=<avatarV>` (publik, di-cache lama; `v` berubah tiap ganti foto). Foto disimpan di PostgreSQL (kolom `bytea`), jadi tidak butuh disk/S3.
- **Moderasi (owner):** `GET /v1/admin/users?q=&filter=banned|muted|verified|avatar`, `PATCH /v1/admin/users/:id` (`verified`, `banned`+`banReason`, `muted`+`muteDays`(kosong = permanen)+`muteReason`, `clearBio`, `clearName`), `DELETE /v1/admin/users/:id/avatar`, `DELETE /v1/admin/users/:id/comments`, `DELETE /v1/admin/users/:id`, `DELETE /v1/admin/comments/:id`. Akun diblokir ditolak di login & semua endpoint bertoken (403 `BANNED`); akun dibisukan ditolak saat `POST /comments` (403 `MUTED`). Akun owner tidak bisa diblokir/dibisukan/dihapus. Migration `010`.
- **Riwayat komentar:** `GET /v1/comments/mine?limit=&before=` (wajib login) — komentar & balasan milik akun, terbaru dulu, tiap item memuat `target` (`s:…`/`c:…`), dengan `total`/`hasMore` untuk paginasi. Migration `007` menambah indeks `(user_id, id DESC)`.
- **Profil publik:** `GET /v1/users/:id` (nama, level, XP, `joinedAt`, `commentCount`; tanpa email) dan `GET /v1/users/:id/comments?limit=&before=` (komentar & balasan pengguna itu, terbaru dulu; `myVote` mengikuti pemirsa bila ada token).
- **Hapus akun:** `DELETE /v1/auth/me?confirm=HAPUS` (wajib login; maks. 3/menit). Baris `users` dihapus; komentar, suara, dan riwayat XP ikut terhapus lewat `ON DELETE CASCADE`.
- **Komentar:** `GET /v1/comments?target=…&limit=…&before=…` (publik), `POST /v1/comments` dan `DELETE /v1/comments/:id` (wajib login; hanya penulis yang bisa menghapus). `target` = `s:<id seri>` (halaman detail) atau `c:<id chapter>` (reader). Komentar maks. 1000 karakter, kiriman dibatasi 10/menit per IP. Belum ada moderasi/balasan; hapus komentar bermasalah lewat SQL (`DELETE FROM comments WHERE id = …`).

## Verified & riwayat baca

Migration `008`.

- **Verified (centang biru):** kolom `users.verified`, ikut di `GET /auth/me`, `GET /users/:id`, dan tiap komentar (`user.verified`). Akun yang emailnya ada di `OWNER_EMAILS` (default `hihanghoheng1507@gmail.com`) ditandai otomatis: akun yang **sudah ada** saat migration dijalankan, dan akun yang **masuk lewat Google** (email sudah diverifikasi Google). Pendaftaran password dengan email itu *tidak* otomatis, karena emailnya belum terbukti milik pendaftar. Tandai manual: `UPDATE users SET verified = true WHERE username = '...';`.
- **Riwayat baca:** `PUT /v1/reading` (wajib login) `{seriesId, chapterId, chapterNumber, chaptersRead, title?}` menimpa satu baris per seri; `GET /v1/users/:id/reading?limit=&before=` (publik, terbaru dulu, `before` = `readAt` item terakhir) memberi `{items: [{seriesId, title, cover, provider, chapterId, chapterNumber, chaptersRead, readAt}], hasMore}`. Judul & cover diambil dari tabel `series` (bukan dari kiriman pengguna, supaya URL cover tidak bisa diisi sembarang); maksimal 200 seri per pengguna (yang terlama dibuang).
- **Sinkron pustaka:** `POST /v1/library/sync` (wajib login) `{since, entries}` — kirim perubahan lokal (maks. 200 entri `{id,title,cover,provider,bookmarked,lastChapterId,lastChapterNumber,readAt,read[],updatedAt}`) dan terima entri yang berubah sejak `since`; balasan `{now, hasMore, entries}`. Bookmark mengikuti perubahan terbaru, daftar chapter dibaca digabung (union) kecuali riwayat direset di versi yang lebih baru. Maksimal 1500 seri per akun.
- **Batas level** dinaikkan dari 1000 ke 10000 supaya tier tampilan level 3000/5000 di app bisa tercapai.

## Login tamu (guest)
`POST /v1/auth/guest` (maks. 5/jam per IP) membuat akun tamu `tamu_xxxxxxxx` tanpa email/password, token berlaku 30 hari; akun tamu yang tak pernah didaftarkan dihapus setelah 35 hari. `user.guest = true`.
Daftar batasan ada di `GET /v1/auth/config` → `guest.limits`. Server menolak dengan `403 GUEST_RESTRICTED` untuk: kirim komentar, like/dislike, ubah profil/foto, `PUT /reading`, `POST /library/sync`. `POST /xp/event` dibalas `gained: 0` tanpa error, dan tamu tidak masuk papan peringkat.
Bookmark, riwayat, dan unduhan tetap jalan lokal di app. `POST /v1/auth/guest/upgrade` (token tamu + `username`, `email`, `password`) mengubah akun tamu jadi akun biasa dengan id yang sama, lalu mengembalikan token baru. Migration `024_guest.sql`.

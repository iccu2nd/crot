# MiToon Backend

REST API (Node 22 + TypeScript + Fastify) untuk aplikasi MiToon: agregator komik dari **Shinigami**, **Lumos**, dan **Kiryuu** dengan format data seragam, fallback otomatis antar provider, cache Redis (stale-while-revalidate), dan PostgreSQL sebagai data utama. Dokumentasi interaktif di `/docs`.

## Jalankan

```bash
# Docker (API + PostgreSQL + Redis)
cp .env.example .env     # isi POSTGRES_PASSWORD & JWT_SECRET
docker compose up -d --build   # API di :3000, dokumentasi di /docs

# Lokal tanpa Docker
cp .env.example .env     # aktifkan DATABASE_URL & REDIS_URL di bagian bawah
npm install && npm run build && npm start
```

Push realtime (opsional): isi `FIREBASE_SERVICE_ACCOUNT` dengan JSON service account Firebase (mentah atau base64). Tiap chapter baru dikirim sebagai pesan data FCM ke topic `s_<sha1(seriesId)[0..24]>`; aplikasi subscribe otomatis untuk komik di bookmark. Kosong = push nonaktif.

Migration berjalan otomatis saat start (`npm run migrate` untuk manual). Env wajib: `DATABASE_URL`, `REDIS_URL` (di compose diisi otomatis), `JWT_SECRET` (produksi). `/docs` (Swagger) mati di produksi (`NODE_ENV=production`); aktifkan dengan `ENABLE_DOCS=1`. `POST /auth/logout-all` mencabut semua token akun. Opsional `TRUST_PROXY` (jumlah reverse proxy tepercaya, default `1`; jangan dikosongkan ke `true`). Pengaturan lain (TTL, rate limit, warmer) ada di `src/config.ts`.

| Perintah | Fungsi |
|---|---|
| `npm test` | unit test (`TEST_DATABASE_URL=... npm test` untuk tes integrasi DB) |
| `npm run typecheck` | cek tipe tanpa build |
| `npm run smoke [provider]` | uji ke situs asli: latest → search → detail → chapter |

## Deploy

**Server / container apa pun:** jalankan `docker compose up -d --build` (butuh Docker + plugin compose), atau build `Dockerfile` sendiri dengan `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` dari environment. API mendengarkan di `PORT` (default 3000); `GET /health` untuk health check. Pasang reverse proxy/HTTPS pilihanmu di depannya (Android memblokir HTTP polos untuk APK). Update: tarik kode baru lalu `docker compose up -d --build`; data aman di volume `pgdata`.

**Vercel (serverless):** `api/index.js` + `vercel.json`; mode serverless aktif otomatis (`VERCEL=1`): tanpa timer latar/warmer, tanpa migrate saat runtime. Butuh PostgreSQL terkelola (URL *pooled*, akhiri `?sslmode=verify-full`) dan Redis (`rediss://...`). Isi `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (centang Production **dan Build**, karena build menjalankan migrate). Server biasa lebih cepat karena L1 cache, warmer, dan prefetch aktif.

## Endpoint (`/v1`)

| Endpoint | Fungsi |
|---|---|
| `GET /search?q&page&limit&provider` | cari di semua provider |
| `GET /latest?page&limit&provider&type` | update terbaru (`type` = comic/manga/novel) |
| `GET /popular?days=7&page&limit` | populer = paling banyak dibuka lewat API ini |
| `GET /recommended` | rating tertinggi, lalu terbaru |
| `GET /genres`, `GET /genres/:slug/series?sort&type&status` | genre & seri per genre (`sort`: latest/popular/rating/az) |
| `GET /series/:id`, `/series/:id/chapters` | detail + chapter |
| `GET /chapters/:id` | gambar chapter + `imageHeaders` (referer wajib untuk provider tertentu) |
| `GET /announcements` | pengumuman aktif (maks. 5) |
| `GET /providers`, `GET /health` | status provider/breaker, cek PostgreSQL & Redis |

Id unified: `<provider>:<id asli>` (`shinigami:<uuid>`, `lumos:<slug>`; `kiryuu:<slug>`; chapter Lumos/Kiryuu `<provider>:<slug>:<chapter-slug>`). Sukses `{ data, meta }`, error `{ error: { code, message } }`.

### Akun, profil, komunitas
- **Login:** hanya Google (`POST /auth/google`, `GET /auth/me`, `GET /auth/config`); tanpa login = pengunjung (data hanya di perangkat). JWT HS256 90 hari. Isi `GOOGLE_CLIENT_ID` (client type *Web*; buat juga client *Android* untuk `id.mitoon.app` + SHA-1 keystore rilis yang tetap).
- **Profil:** `PATCH /auth/me` (`displayName` ≤30, `username` sekali per 7 hari → `429 USERNAME_COOLDOWN`, `bio` ≤150 & 3 baris); avatar JPEG ≤300 KB lewat `PUT/DELETE /auth/me/avatar`, publik `GET /users/:id/avatar?v=`; profil publik `GET /users/:id`; hapus akun `DELETE /auth/me?confirm=HAPUS`.
- **XP & level:** aturan di `src/core/xp.ts` (baca +10, komentar +5, pustaka +3, buka harian +5, disukai +1; batas harian WIB). App melapor `POST /xp/event {type: read|bookmark|daily, ref}`; peringkat mingguan `GET /xp/leaderboard`. **Streak membaca:** hari WIB tempat pengguna membaca ≥1 chapter dicatat di `read_days` (migrasi 030); `POST /xp/event` dan `GET /xp/streak` mengembalikan `{current, readToday}` (streak masih hidup bila kemarin membaca dan hari ini belum).
- **Komentar:** `GET/POST /comments` (target `s:<id seri>` / `c:<id chapter>`, ≤1000 karakter, 10/menit per IP), balasan 1 tingkat, vote `PUT /comments/:id/vote`, riwayat `GET /comments/mine`.
- **Global Chat:** `GET /chat` (publik, 50 pesan terakhir lama→baru), `POST /chat` (login, 1–500 karakter; `replyTo` opsional = id pesan yang dibalas, kutipan disimpan di kolom `reply_*` lewat migrasi `032_chat_reply.sql`), `DELETE /chat/:id` (milik sendiri; owner bebas). Tabel `chat_messages` otomatis dipangkas ke 50 baris tiap ada pesan baru (migrasi `031_chat.sql`).
- **Riwayat baca & pustaka:** `PUT /reading`, `GET /users/:id/reading`, `POST /library/sync` (maks. 1500 seri/akun).
- **Notifikasi:** `GET /notifications/unread` → `{ count, notif, info }`, `POST /notifications/read?kind=notif|info|all`.
- **Verified:** email di `OWNER_EMAILS` otomatis verified + akses admin saat masuk Google.

### Admin
Aktif bila `ADMIN_TOKEN` diisi (tidak tampil di `/docs`, 10 request/menit): pengumuman (`POST/DELETE /admin/announcements`, header `x-admin-token`) dan moderasi pengguna/komentar/seri untuk owner (`/admin/users`, `/admin/comments`, ...). Akun owner tidak bisa diblokir/dibisukan/dihapus. Paksa keluar sesi: `POST /admin/users/:id/logout` (satu user) dan `POST /admin/logout-all` (semua user; admin pemanggil tetap masuk, kirim `{"includeSelf":true}` untuk ikut keluar).

## Manajemen storage database (200 MB)

Batas kapasitas dibaca dari `pg_database_size` (tabel + indeks + TOAST) dan dibandingkan dengan `STORAGE_LIMIT_MB` (default 200, hitungan desimal agar konservatif). Kapasitas fisik tetap terbatas: sistem ini memperlambat pertumbuhan, membuang data yang bisa diturunkan ulang, dan memperingatkan lebih awal, bukan membuat database tanpa batas.

| Level | Pemakaian | Tindakan otomatis |
|---|---|---|
| ok / notice | < 80% | crawler penuh; cache chapter seri yang tak dibuka 90/60 hari dibersihkan |
| warning | 80% | crawler ringan (3 halaman, tanpa seed), enrich 50%, batas unggahan foto profil 50%, seri usang 120 hari dibersihkan, peringatan |
| high | 90% | crawler mati, chapter hanya diperbarui untuk seri yang sudah punya chapter, batas unggahan 25%, seri usang 60 hari dibersihkan |
| critical | 95% | tulis katalog dihentikan, unggahan foto profil ditolak (HTTP 507), cache chapter dikosongkan bila `VACUUM FULL` tak muat, `/health` berstatus `degraded` |

Akun, bookmark, pustaka, riwayat baca, total XP, komentar, chat, dan foto profil pengguna tidak pernah dihapus otomatis. Penulisan data akun tetap berjalan di semua level (cadangan 5%). Pembersihan hanya menyentuh data yang bisa diambil ulang dari sumber: chapter seri yang tak dibuka/disimpan siapa pun, seri yang sudah lama hilang dari sumber, statistik view lama, laporan chapter rusak, pengumuman kedaluwarsa, dan buku besar `xp_events` yang lebih tua dari 60 hari (hanya catatan anti-dobel XP; total XP, level, dan streak tetap).

Penghematan permanen: crawler dan enrich hanya menyimpan metadata seri + genre (daftar chapter hanya disimpan untuk seri yang dibuka pengguna, dipanaskan warmer, atau dipantau push); upsert katalog tidak menulis ulang baris yang tak berubah (jeda 10 menit untuk `last_seen_at`); foto profil identik tidak ditulis ulang; indeks `series_norm_title_idx` yang redundan dihapus; autovacuum tabel panas dipercepat (migrasi 038).

Fitur yang dihapus karena membengkakkan database dan tidak cukup berguna (migrasi 039): stiker (tabel `stickers`, endpoint `/stickers/*`; pesan yang hanya berisi stiker diganti `[stiker dihapus]`), background header profil (kolom `header_*`, `/auth/me/header`, `/users/:id/header`), foto profil GIF (unggahan baru ditolak; GIF lama tetap tampil), dan pembelian Premium (`/premium/plans`, `/premium/orders*`, tabel `premium_orders` dihapus bila tak ada pesanan lunas, kalau ada riwayat lunas tabelnya dipertahankan). Premium kini diberikan admin dan hanya membuka badge, bonus XP, tema, dan frame (`PATCH /auth/me/style`).

Pemantauan: pemeriksaan tiap menit, level + ramalan waktu menuju kritis (sampel per jam), peringatan ke log, riwayat `storage_events`, dan webhook opsional `STORAGE_ALERT_WEBHOOK_URL`. Pembersihan rutin tiap 6 jam (tiap 30 menit saat level warning ke atas).

| Endpoint admin (owner JWT atau `x-admin-token`) | Fungsi |
|---|---|
| `GET /v1/admin/storage` | pemakaian, level, kebijakan aktif, tabel terbesar, pemakaian blob, ramalan, daftar backup |
| `GET /v1/admin/storage/events` | riwayat level, pembersihan, backup |
| `POST /v1/admin/storage/maintain` `{mode: "auto"\|"aggressive"}` | jalankan pembersihan sekarang |
| `POST /v1/admin/storage/backups`, `GET /v1/admin/storage/backups[/:nama]` | buat, daftar, unduh backup |
| `GET /v1/admin/storage/export` | backup langsung diunduh (juga untuk serverless) |
| `GET /v1/internal/storage/cron` | cron Vercel (header `Authorization: Bearer $CRON_SECRET`) |
| `GET /v1/internal/champions/cron` | cron Vercel mingguan (Senin 00.05 WIB), header sama: membekukan Top 3 minggu lalu + kirim push juara |

Backup: tiap 24 jam ke `BACKUP_DIR` (snapshot konsisten, NDJSON gzip, diverifikasi setelah ditulis, simpan 7 harian + 4 mingguan). Isinya data pengguna dan kurasi admin (users termasuk foto, komentar, vote, XP, streak, riwayat, pustaka, pengumuman, gambar chapter hasil perbaikan); katalog komik tidak dicadangkan karena bisa diambil ulang. Volume Docker ikut server yang sama, jadi unduh salinan ke luar server secara berkala (`/admin/storage/export`). Serverless tidak punya disk tetap: pakai endpoint export dari cron eksternal. Manual: `npm run backup`. Pulihkan ke database kosong atau yang sudah ada (hanya mengisi baris yang hilang, tidak menimpa): `npm run restore -- backups/mitoon-AAAAMMDD-JJMMDD.ndjson.gz`.

## Cara kerja singkat
- **Cache:** L1 di memori + Redis, stale-while-revalidate + singleflight; Redis mati = cache dilewati, API tetap jalan. Respons gzip + ETag + `Cache-Control`/`s-maxage`. Rate limit di memori (300/menit per IP).
- **Fallback:** list memanggil semua provider paralel dan hanya menunggu provider lambat `listGraceMs`; detail/chapter yang gagal dicari di provider lain (judul ternormalisasi, chapter dicocokkan lewat nomor). Circuit breaker per provider (5 gagal → buka 30 dtk). Tanpa Redis, detail dilayani dari PostgreSQL.
- **Warmer** (server biasa): mengisi cache/DB berkala, crawl katalog genre, prefetch chapter berikutnya.
- **Database:** `migrations/*.sql` transaksional dengan advisory lock; pool 10 (Vercel 2), `statement_timeout` 8 dtk. Jangan ubah nama/isi migration yang sudah dijalankan.
- **Shinigami:** domain situs & API ditulis langsung di `src/providers/shinigami.ts` (`BASE`, `API`).
- **Kiryuu:** scraping HTML (tanpa browser headless), prioritas terendah. Domain lewat env `KIRYUU_BASE` (default `https://v7.kiryuu.to`). Bila Cloudflare menampilkan tantangan, isi `KIRYUU_COOKIE` (`cf_clearance=...`) dan `KIRYUU_UA` (User-Agent browser yang sama). Pencarian memakai endpoint `admin-ajax.php?action=search` (nonce diambil otomatis dari beranda) digabung `/advanced-search/?search_term=`.

## Juara mingguan (Top 3)

Tiap Senin 00.00 WIB, tiga teratas papan XP minggu yang baru selesai dibekukan ke tabel `weekly_winners` (migrasi `040`) oleh `WeeklyChampions`: timer 10 menit di server biasa, atau cron `/v1/internal/champions/cron` di serverless. Tiap juara dikirimi push data-only `type=toprank` ke topic pribadi `u_<id>` (app subscribe saat login); push yang gagal dicoba lagi selama 3 hari, yang sudah terkirim tidak diulang. Riwayatnya publik di `GET /v1/users/:id/champions`. Tag `topRank` (1-3) di komentar, chat, dan profil diambil dari papan minggu berjalan.

# Registrasi UNZ – Sistem Tiket & Check-in

![License](https://img.shields.io/badge/license-MIT-blue.svg)

Sistem ini memfasilitasi distribusi kode tiket, pembuatan QR, dan proses check‑in peserta acara. Infrastruktur utama dibangun di atas **Cloudflare Workers + D1 Database** dengan beberapa utilitas tambahan (Python scripts untuk generate kode & QR). Proyek juga memiliki fallback dashboard statis dan mode pembekuan (read‑only) setelah acara selesai.

---
## Daftar Isi
1. [Arsitektur Ringkas](#arsitektur-ringkas)
2. [Fitur Utama](#fitur-utama)
3. [Struktur Repository](#struktur-repository)
4. [Alur Data & Proses](#alur-data--proses)
5. [Model Data](#model-data)
6. [Environment Variables & Secret](#environment-variables--secret)
7. [Endpoint API](#endpoint-api)
8. [Dashboard](#dashboard)
9. [Mode Beku (Freeze / Read‑Only)](#mode-beku-freeze--read-only)
10. [Skrip Utilitas (Python)](#skrip-utilitas-python)
11. [Build & Deploy](#build--deploy)
12. [Testing](#testing)
13. [Troubleshooting & FAQ](#troubleshooting--faq)
14. [Roadmap / Ide Lanjutan](#roadmap--ide-lanjutan)
15. [Lisensi / Catatan Internal](#lisensi--catatan-internal)

---
## Arsitektur Ringkas
Komponen utama:
- **Cloudflare Worker (`registrasi-unz-api`)**: Endpoint otentikasi, validasi, update status tiket, statistik, listing peserta.
- **D1 (SQLite managed)**: Tabel `tickets` & `logs`.
- **Durable Object (CheckinHub)**: Digunakan untuk broadcast real-time (WebSocket) selama acara aktif (saat ini diblokir jika freeze aktif).
- **Dashboard Dinamis**: Disajikan langsung oleh Worker (`/dashboard`).
- **Dashboard Statis**: Fallback di `public/dashboard/index.html` (di-serve oleh assets binding).
- **Google Sheets Sync (Cron)**: Scheduled job yang menarik data spreadsheet → sinkron ke D1.
- **Python Scripts**: `generate_codes.py` untuk pool kode; `generate_qr.py` untuk QR dengan logo & signature HMAC.

---
## Fitur Utama
- Login admin + JWT sederhana (HS256) / API key gate.
- Validasi & check-in kode (dengan rate limit + debouncing).
- Listing peserta dengan filter: sudah check-in / belum (termasuk versi full untuk belum).
- Ekspor CSV untuk analisis lanjutan.
- Realtime broadcast (saat event aktif) – dapat dipangkas saat freeze.
- Mode Beku: mematikan operasi mutasi & WebSocket.
- Statistik ringkas / agregat (total, used, per-hour, last-hour).
- CORS aman (hanya origin yang diizinkan + self-origin Worker).

---
## Struktur Repository
```
.
├─ registrasi-unz-api/           # Cloudflare Worker (API + dynamic dashboard)
│  ├─ src/index.ts               # Handler utama + endpoint
│  ├─ public/dashboard/index.html# Fallback dashboard statis
│  ├─ docs/FREEZE_MODE.md        # Dokumentasi mode beku
│  ├─ package.json               # Dependensi & script Worker
│  └─ wrangler.jsonc             # Konfigurasi Worker
├─ functions/                    # (Opsional) Firebase Functions (belum fokus utama sekarang)
├─ generate_codes.py             # Script membuat pool kode acak
├─ generate_qr.py                # Script generate QR untuk setiap kode
├─ code_pool.csv                 # Hasil generate kode mentah
├─ qrs/                          # Output gambar QR per kode
└─ assets/                       # Logo / poster / gambar pendukung
```

---
## Alur Data & Proses
1. Admin menyiapkan pool kode → (opsional) import ke Google Sheet.
2. Cron Worker menarik data sheet secara periodik → upsert ke tabel `tickets`.
3. Peserta datang → kode dipindai → front-end gate memanggil `/validate` lalu `/mark-used` jika valid & belum dipakai.
4. Worker update kolom `used=1, used_at=timestamp`.
5. (Saat realtime aktif) broadcast via Durable Object ke monitor.
6. Setelah acara selesai → aktifkan freeze → semua mutasi berhenti, hanya view & export.

---
## Model Data
Tabel inti (perkiraan kolom – sesuaikan dengan skema aktual di D1):
- `tickets`:
  - `code` (TEXT PRIMARY KEY)
  - `name` (TEXT)
  - `email` (TEXT)
  - `wa` (TEXT) – nomor WhatsApp
  - `used` (INTEGER 0/1)
  - `used_at` (DATETIME nullable)
  - `qr_url` (opsional jika disimpan)
- `logs`:
  - `ts` (DATETIME)
  - `code` (TEXT)
  - `admin_id` (TEXT)
  - `result` (TEXT: OK / ALREADY_USED / NOT_FOUND / dll.)

---
## Environment Variables & Secret
Didefinisikan di `wrangler.jsonc` (`vars`) atau via `wrangler secret put`.

Public (non-sensitive) vars:
- `CORS_ORIGIN` – Origin front-end resmi.
- `SHEET_ID` – ID Google Sheet.
- `SHEET_NAME` – Worksheet name (misal: `participants`).
- `EVENT_CLOSED` – `"1"` jika freeze aktif.

Legacy / alias:
- `SPREADSHEET_ID` – Masih ada untuk kompatibilitas (gunakan `SHEET_ID`).

Secrets (set dengan `wrangler secret put`):
- `SHEETS_SA_EMAIL` – Service Account email.
- `SHEETS_SA_KEY` – Private key (boleh full JSON service account atau hanya key, script auto-deteksi).
- `GATE_API_KEY` – Alternatif auth untuk integrasi (header `x-gate-key`).
- `GATE_JWT_SECRET` (jika digunakan; atau di-hardcode) – Secret HMAC JWT.

Catatan: Jangan commit nilai secret ke repo.

---
## Endpoint API
Semua response JSON minimal mengandung `{ ok: boolean, ... }`.

Mutasi (dinonaktifkan saat freeze):
- `POST /login` – Body `{ username, password }` → JWT.
- `POST /validate` – Body `{ code }` → Cek eksistensi & status dipakai.
- `POST /mark-used` – Body `{ code }` → Tandai used (idempotent-ish) + log.
- `GET /ws` – WebSocket upgrade (monitor realtime) – ditolak saat freeze.

Listing / View:
- `GET /checked-in` – (Legacy) daftar peserta used (pagination, q, CSV export via `?export=csv`).
- `GET /participants` – Param:
  - `used=1|0`
  - `limit` (default 100, max 500)
  - `offset`
  - `q` (LIKE filter code/name/email)
  - `export=csv`
- `GET /participants-unused` – Semua yang belum (CAP 5000 default; field `capped` & `cap`). Mendukung `q`, `export=csv`.
- `GET /stats` – Ringkasan: total, used, used_last_hour, perHour[] (bucket hour ISO).
- `GET /dashboard` – Dashboard dinamis (HTML).
- `GET /health` – Status JSON `{ mode, version, uptime_ms }`.
- `POST /sync-now` – (Debug) paksa sinkron sheet (perlu auth) – dilewati saat freeze.

Status kode dipakai khusus:
- `401` Unauthorized.
- `404` Kode tidak ditemukan.
- `409` Kode sudah dipakai.
- `410` Event closed (freeze mode) – untuk endpoint mutasi.
- `429` Rate limit / Debounce.
- `500` Error server.

Auth:
- Bearer token (`Authorization: Bearer <jwt>`) atau `x-gate-key`.
- JWT memuat `admin_id` simpel.

Rate Limiting & Debounce:
- Token bucket IP: 5 kapasitas, refill 5/s.
- Debounce kode: 500ms (menghindari double scan super cepat).

---
## Dashboard
Mode / fitur:
- Toggle: Sudah / Belum check-in.
- Pencarian multi kolom (code, name, email) case-insensitive (LIKE).
- Pagination (hanya untuk mode Sudah).
- Export CSV (menyesuaikan mode).
- Auto refresh (default 15s) untuk mode Sudah.
- Mode Belum: memuat penuh (CAP) satu kali tanpa pagination.
- Freeze badge tampil bila `mode=closed` dari `/health`.

Statis vs Dinamis:
- Dinamis: embed langsung dalam Worker (lebih up-to-date).
- Statis: fallback; menanyakan `/health` untuk badge.

---
## Mode Beku (Freeze / Read‑Only)
Saat `EVENT_CLOSED=1`:
- `/login`, `/validate`, `/mark-used`, `/ws` → diblokir (HTTP 410 + `{ error: 'EVENT_CLOSED' }`).
- Cron sinkronisasi dilewati.
- Dashboard menampilkan badge.
- Lihat detail lengkap di `registrasi-unz-api/docs/FREEZE_MODE.md`.

Re-open: Set `EVENT_CLOSED=0` atau hapus var → deploy ulang → verifikasi `/health`.

---
## Skrip Utilitas (Python)
### `generate_codes.py`
Membuat kumpulan kode acak pola `D L D L D` (D=digit 1-9, L=huruf A-Z) sambil menghindari pola terlalu mudah (triple repeating, ascending/descending sequence, dsb). Output ke `code_pool.csv`.

### `generate_qr.py`
Membuat QR per kode:
- Menambahkan signature HMAC (6 byte → Base32) sebagai parameter `s`.
- Logo overlay di tengah (19% lebar QR) dengan koreksi error tinggi.
- Warna kustom (#435258) untuk modul QR.
- Output PNG ke folder `qrs/`.

Pastikan install dependensi:
```
pip install qrcode[pil] pillow
```
Ganti `HMAC_SECRET` sebelum produksi.

---
## Build & Deploy
### API (Cloudflare Worker)
Prereq: Node.js + `wrangler`.
```
npm install
npm run deploy
```
Dev lokal:
```
npm run dev
```
Tambah secret:
```
wrangler secret put SHEETS_SA_EMAIL
wrangler secret put SHEETS_SA_KEY
wrangler secret put GATE_API_KEY
```

### Firebase (Jika digunakan)
Folder `functions/` berisi boilerplate; bukan jalur utama sistem check-in ini. Deploy hanya jika diperlukan integrasi lanjutan.

### QR Generation
```
python generate_codes.py
python generate_qr.py
```

---
## Testing
Konfigurasi `vitest` tersedia, namun belum ada test suite khusus. Ide test potensial:
- Unit: validasi rate limit, debounce, hashing.
- Integration (workers env): simulasi `/mark-used` idempotent.
- Regression: freeze mode guard.

Menjalankan (placeholder):
```
npm test
```

---
## Troubleshooting & FAQ
| Gejala | Penyebab | Solusi |
|--------|----------|--------|
| `EVENT_CLOSED` tapi masih bisa login | Worker lama cache | Tunggu propagasi / redeploy paksa |
| CSV export kosong | Token expired / 401 | Login ulang, cek storage local browser |
| QR tidak terbaca | Logo terlalu besar / cetak buram | Kurangi ukuran logo, periksa koreksi H tingkat H |
| Kode dianggap sudah dipakai padahal baru | Double scan sangat cepat | Debounce 500ms; tunggu sebentar lalu coba lagi |
| `/sync-now` gagal | Credential SA salah format | Pastikan `SHEETS_SA_KEY` benar & newline di-escape |
| Badge freeze tidak muncul di statis | Cache | Hard refresh (Ctrl+F5) |

---
## Roadmap / Ide Lanjutan
- Index tambahan: `CREATE INDEX idx_tickets_used ON tickets(used, used_at)` untuk query cepat.
- Keyset pagination (instead of offset) untuk skala besar.
- Mode delta realtime tanpa DO (Server-Sent Events sederhana) jika ingin memangkas DO.
- Hash salted + pepper secret untuk password admin (kalau diperluas multi admin).
- Menambahkan test otomatis & CI (GitHub Actions).
- Auto-archive log lama ke storage murah.

---
## Lisensi / Catatan Internal
Lisensi: [MIT](./LICENSE)

Catatan internal:
- Pastikan secret tidak pernah di-commit.
- File credential service account harus disimpan terpisah / secret manager.

---
## Kontak / Pemeliharaan
- Pemilik awal: Tim Event / Teknologi internal.
- Untuk reaktivasi hubungi dev yang terakhir melakukan deploy.

---
Selamat menggunakan sistem. Lihat juga: `registrasi-unz-api/docs/FREEZE_MODE.md`.

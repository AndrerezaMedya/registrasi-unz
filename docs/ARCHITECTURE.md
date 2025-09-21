# Arsitektur Sistem Registrasi UNZ

```mermaid
digraph G {
  rankdir=LR;
  subgraph cluster_users { label="Users"; style=dashed; Gate["Gate Scanner UI"]; Monitor["Monitor Dashboard"]; Admin["Admin (Dashboard / CLI)"]; }

  Gate -> Worker["Cloudflare Worker API"] [label="/validate /mark-used"]
  Admin -> Worker [label="/dashboard /participants /stats"]
  Monitor -> Worker [label="/ws (realtime)"]

  Worker -> D1[("D1 DB\n(tickets, logs)")]
  Worker -> Sheets[("Google Sheets\nParticipants")]
  Cron["Scheduled Cron (*/2 min)"] -> Worker [label="sync"]
  Worker -> DO["Durable Object\nCheckinHub"] [label="broadcast"]
  DO -> Monitor [label="push events"]

  subgraph cluster_assets { label="Static Assets"; StaticDash["/public/dashboard/index.html"]; QRs["Generated QR Images"]; }
  StaticDash -> Admin
  QRs -> Gate [label="scan"]
}
```

## Komponen Utama
| Komponen | Deskripsi | Catatan |
|----------|-----------|---------|
| Cloudflare Worker | Service utama handling auth, cek tiket, list, stats | TypeScript (`src/index.ts`) |
| D1 Database | Penyimpanan tiket & log | Skema sederhana, cocok untuk event scale menengah |
| Durable Object (CheckinHub) | Broadcast realtime via WebSocket | Dinonaktifkan saat freeze |
| Google Sheets | Sumber data peserta (sinkron ke D1) | Cron setiap 2 menit |
| Dashboard Dinamis | HTML disajikan Worker (`/dashboard`) | Menampilkan mode freeze badge |
| Dashboard Statis | Fallback `public/dashboard/index.html` | Cek `/health` untuk mode |
| Python Scripts | Generate pool kode & QR | HMAC signature untuk integritas URL |

## Alur Realtime (Ketika Tidak Freeze)
1. Gate scan → POST `/validate` → jika OK dan belum used → POST `/mark-used`.
2. Worker update row di `tickets` (`used=1, used_at=NOW`).
3. Worker memanggil DO untuk broadcast event JSON.
4. Monitor (WebSocket) menerima event dan update UI.

## Mode Freeze
- Endpoint mutasi + WebSocket diblokir (410).
- Cron sync dilewati.
- Dashboard menampilkan status read-only.

## Pertimbangan Keamanan
- Secret SA disimpan via `wrangler secret` (tidak commit ke repo).
- Rate limit + debounce mencegah brute-force kode.
- HMAC signature pada QR bisa dipakai validasi tambahan (opsional belum diverifikasi server side penuh).

## Skalabilitas
- D1 cocok hingga puluhan ribu tiket; untuk ratusan ribu, pertimbangkan indeks tambahan dan pagination keyset.
- DO realtime bisa diganti SSE jika ingin kurangi kompleksitas.

## Observability
- Log console Worker + metric sederhana melalui `/health`.
- Potensi: tambahkan dashboard eksternal (Grafana / Cloudflare Analytics) jika dibutuhkan.

## Diagram Peran Saat Freeze
```mermaid
graph TD
  A[Gate Scanner] -->|Validation Blocked| W[Worker (Frozen)]
  Admin -->|Read Only| W
  W --> D1
  W -->|No Broadcast| DO[Durable Object]
  DO -. idle .-> Admin
```

## Next Steps Arsitektural (Opsional)
- Tambah caching layer untuk listing unused (ETag/If-None-Match).
- Simpan ringkas agregat (materialized counters) untuk stats cepat.
- Hardening JWT (exp, iat, signature rotation).

--
Dokumen ini melengkapi `README.md` untuk gambaran visual & keputusan desain.

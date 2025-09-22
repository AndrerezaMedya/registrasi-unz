# Mode Beku (Read-Only)

Dokumen ini menjelaskan cara kerja dan cara mengaktifkan / menonaktifkan mode beku (`EVENT_CLOSED`).

## Ringkasan

Ketika `EVENT_CLOSED=1`:

- Endpoint tulis / mutasi diblokir: `/login`, `/validate`, `/mark-used`, `/ws`.
- Broadcast WebSocket (Durable Object) tidak digunakan (endpoint /ws ditolak lebih awal).
- Dashboard menampilkan badge "EVENT FROZEN / READ-ONLY".
- Cron / scheduled sync ke Google Sheets dilewati.
- `/health` mengembalikan `mode: "closed"`.

## Tujuan

Menghentikan perubahan data dan mengurangi konsumsi resource (Durable Object & sync) setelah acara selesai, sembari tetap bisa melihat data peserta.

## Mengaktifkan Mode Beku

1. Tambahkan / set variabel di `wrangler.jsonc`:
   ```jsonc
   {
   	// ...
   	"vars": {
   		// variabel lain
   		"EVENT_CLOSED": "1"
   	}
   }
   ```
2. Deploy ulang worker:
   (Contoh perintah; sesuaikan dengan script yang Anda gunakan)
   ```bash
   wrangler deploy
   ```
3. Verifikasi:
   - Akses `/health` → harus ada `"mode":"closed"`.
   - Coba POST `/mark-used` → harus menerima error `EVENT_CLOSED` (HTTP 410).

## Membuka Kembali (Re-Open)

1. Ubah / hapus variabel:
   - Set `EVENT_CLOSED` ke `0` atau hapus entry tersebut dari `vars`.
2. Deploy ulang.
3. Verifikasi `/health` menampilkan `"mode":"open"`.
4. Dashboard otomatis menghilangkan badge (versi dinamis). Versi statis akan mendeteksi lagi saat load halaman (fetch `/health`).

## Catatan Teknis

- Variabel lingkungan Cloudflare tidak bisa diubah tanpa redeploy (immutable pada runtime). Itulah alasan toggling memerlukan redeploy.
- Jika kelak diperlukan toggle runtime tanpa deploy, perlu storage terpisah (mis. D1 mini table / Durable Object state) + endpoint admin khusus (belum diimplementasi karena tidak diminta).
- Status kode yang dipakai untuk penolakan: `410 Gone` (dapat diubah menjadi `403 Forbidden` jika diinginkan).
- Durable Object sepenuhnya dihentikan dengan check internal di handler DO dan logging debug untuk monitoring penggunaan saat freeze.

## Dampak Terhadap Data

Tidak ada migrasi atau perubahan skema; hanya guard logic. Data tetap dapat diekspor melalui endpoint listing yang masih aktif.

## Endpoint Masih Aktif Saat Beku

- `/participants`, `/participants-unused`, `/checked-in`, `/stats`, `/health`, `/dashboard` (view-only)
- Export CSV tetap berjalan.

## Troubleshooting

| Masalah                                | Penyebab Umum                                | Solusi                                                               |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Badge tidak muncul di dashboard statis | Cache CDN / browser                          | Hard refresh (Ctrl+F5) / purge cache                                 |
| `/health` masih open setelah set var   | Deploy belum dijalankan atau var salah ejaan | Periksa `wrangler.jsonc` dan ulangi deploy                           |
| Masih bisa login                       | Versi worker lama masih aktif                | Tunggu propagasi atau cek environment (staging vs production)        |
| Masih ada penggunaan DO saat freeze    | Check internal belum aktif atau log error    | Periksa Cloudflare logs untuk `[FREEZE]` atau `[DO FREEZE]` messages |

## Audit Cepat (Checklist)

Sebelum menutup acara: pastikan sudah melakukan export data final jika diperlukan.
Setelah membuka kembali: lakukan uji coba satu kode dummy untuk memastikan alur normal kembali.

--
Dokumen ini dibuat otomatis. Perbaharui sesuai kebutuhan internal.

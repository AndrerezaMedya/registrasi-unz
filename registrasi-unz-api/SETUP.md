# Setup & Deployment Notes

## 1. D1 Schema Index (run once)

```
wrangler d1 execute registrasi_unz --command "CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);"
```

## 2. Secrets

```
wrangler secret put SHEETS_SA_EMAIL
wrangler secret put SHEETS_SA_KEY   # Paste full PEM key; newlines auto-handled. If escaped manually, keep \n.
wrangler secret put GATE_API_KEY
```

## 3. Deploy Worker

```
npm run deploy
```

## 4. Test Endpoints

```
# All protected endpoints require x-gate-key
curl -X POST https://<your-worker>/validate \
  -H "Origin: https://registrasi-unz.web.app" \
  -H "x-gate-key: <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"code":"AAA01"}'
```

## 5. Firebase Hosting Cache Headers

Add to firebase.json (merge with existing):

```json
{
	"hosting": {
		"headers": [
			{ "source": "/qrs/**", "headers": [{ "key": "Cache-Control", "value": "public,max-age=31536000,immutable" }] },
			{ "source": "/assets/**", "headers": [{ "key": "Cache-Control", "value": "public,max-age=31536000,immutable" }] }
		],
		"cleanUrls": true
	}
}
```

Deploy hosting:

```
firebase deploy --only hosting
```

## 6. Generating QR PNGs

Use existing Python script or create one:

```python
# generate_qr_assets.py
import csv, qrcode, os
INPUT='code_pool.csv'  # or pull from sheet export
OUT='public/qrs'
os.makedirs(OUT, exist_ok=True)
for row in csv.DictReader(open(INPUT, newline='', encoding='utf-8')):
    code=row['code'].strip()
    if not code: continue
    img=qrcode.make(code)
    img.save(f'{OUT}/{code}.png')
```

Upload to hosting (ensure public/qrs is included before deploy).

## 7. Realtime

WebSocket: wss://<worker-domain>/ws?admin_id=ADMIN

## 8. Logs Table (optional)

```
CREATE TABLE IF NOT EXISTS logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT CURRENT_TIMESTAMP,
  code TEXT,
  admin_id TEXT,
  result TEXT
);
```

## 9. Rate Limit & Debounce

- Rate limit: 5 requests/second per IP (429 RATE_LIMIT).
- Debounce: identical code reuse within 500ms may return 429 DEBOUNCE.

## 10. Troubleshooting

- 401 on /validate or /mark-used -> check x-gate-key.
- 409 on /mark-used -> code already used.
- Cron not syncing: verify secrets SHEETS_SA_EMAIL / SHEETS_SA_KEY and share sheet with service account email.

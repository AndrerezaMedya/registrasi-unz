# Acceptance Test Guide

## QR Assets

- Pick 3 sample codes (e.g., AAA01, AAA02, AAA03) existing in sheet.
- Visit https://registrasi-unz.web.app/qrs/AAA01.png -> HTTP 200 and Cache-Control: public,max-age=31536000,immutable.

## /validate (requires x-gate-key)

POST /validate {"code":"AAA01"}
Headers: Origin: https://registrasi-unz.web.app, x-gate-key: <KEY>

- Response 200 JSON { ok:true, used:false|true, name,email }
  POST /validate {"code":"NOTEXIST"}
- Response 404 JSON { ok:false, error:"NOT_FOUND" }
  Missing/invalid key -> 401 { ok:false, error:"UNAUTHORIZED" }

## /mark-used

POST /mark-used first time { code: AAA01, admin_id: adminA }

- Header x-gate-key must match secret.
- Response 200 { ok:true, result:"USED" }
  POST /mark-used again same code
- Response 409 { ok:false, error:"ALREADY_USED" }
  Debounce: second identical request within 500ms may return 429 { ok:false, error:"DEBOUNCE" }
  Rate limit: >5 req/s IP -> 429 { ok:false, error:"RATE_LIMIT" }

## Cron Sync

- Add new row with unique code in Google Sheet (columns: name,email,wa,code,qr_url).
- Wait ≤2 minutes.
- Query D1: SELECT name,email,wa,code,qr_url,used,used_at FROM tickets WHERE code='NEWCODE'; row exists.

## Headers

- GET a QR asset: confirm Cache-Control & immutable.
- Validate CORS: Origin different from https://registrasi-unz.web.app should be blocked with 403.

## WebSocket (future real-time)

- Open ws endpoint: wss://<worker-domain>/ws?admin_id=adminA (after deployment) -> connection 101.
- After /mark-used for a code, expect broadcast message { code, name, used_at }.

---

## Final Evidence (v0.9.0)

### /stats Output Sample

HTTP 200

```
{"ok":true,"total":5,"used":4,"unused":1,"last_hour":3,"per_hour":[{"hour":"2025-09-20T09:00:00Z","used":1},{"hour":"2025-09-20T10:00:00Z","used":3}]}
```

### Parallel Mark-Used Contention

- 3 concurrent requests on same new code -> 1 × 200 (USED) + 2 × 409 (ALREADY_USED)

### Rate Limit

- > 5 rapid requests -> at least one 429 (RATE_LIMIT)

### Cache Header (QR Asset)

GET /qrs/SAMPLE3.png

```
Cache-Control: public,max-age=31536000,immutable
```

### WebSocket Broadcast

- On marking code USED monitor received JSON `{ code, name, used_at, result:"USED" }` under 1s.
- Auto-reconnect: on redeploy shows sequence: `reconnecting` -> `connected`.

### Cron Test (Owner Procedure)

1. Add row to Google Sheet with code `SAMPLE_BARU` (columns: name,email,wa,code,qr_url).
2. Wait ≤2 minutes (cron \*/2 schedule).
3. Run:

```
wrangler d1 execute registrasi_unz --remote --command "SELECT code,name,email,used FROM tickets WHERE code='SAMPLE_BARU';"
```

4. Expect one row with used=0.

## Updated Endpoints Summary

| Endpoint   | Auth   | Success                                          | Error Format                                   |
| ---------- | ------ | ------------------------------------------------ | ---------------------------------------------- |
| /login     | none   | {ok:true,token,admin_id}                         | {ok:false,code,message}                        |
| /validate  | Bearer | {ok:true,used,name,email}                        | 404 NOT_FOUND / others {ok:false,code,message} |
| /mark-used | Bearer | {ok:true,result:"USED"}                          | 409 ALREADY_USED /429 RATE_LIMIT / etc.        |
| /stats     | Bearer | {ok:true,total,used,unused,last_hour,per_hour[]} | {ok:false,code,message}                        |
| /health    | none   | {ok:true,ts}                                     | -                                              |

All errors standardized to shape `{ ok:false, code:'ERR_CODE', message:'Human readable message' }`.

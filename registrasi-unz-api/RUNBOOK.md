# RUNBOOK – Event Day Operations

Version: v0.9.0

## 1. Roles & URLs

- Gate Scanner: https://registrasi-unz.web.app/gate/
- Monitor Dashboard: https://registrasi-unz.web.app/monitor/
- API Base: https://registrasi-unz-api.formsurveyhth.workers.dev

## 2. Login

1. Open page (gate or monitor).
2. Enter username/password (e.g., gate1 / unz123).
3. On success token is stored in localStorage. Token lifetime ~12h.

Recovery:

- If token expires: page will start returning 401; refresh and login again.
- If camera fails (gate): ensure browser permission granted; reload.

## 3. Scanning Flow (Gate)

1. Camera auto-starts; QR or barcode detection triggers /validate.
2. Status Colors:
   - Green (OK / USED success) – valid ticket or successfully marked used
   - Red (NOT FOUND / ERROR) – invalid code or server error
3. Sounds:
   - High-pitch beep = success (valid or used ok)
   - Low-pitch beep = error / not found
4. After validation, press MARK to consume the ticket.

## 4. WebSocket Real-time

- Monitor & Gate open a WS connection after login.
- On ticket marked used broadcast JSON: `{ code, name, used_at, result:"USED" }`.
- Auto-reconnect with exponential backoff up to 30s.
- Heartbeat: client sends ping every 20s (after hardening) – if 2 misses => force reconnect.

## 5. Quick Recovery Scenarios

| Symptom                                        | Action                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| WS status shows reconnecting continuously >30s | Hard refresh page (Ctrl+F5). Check Worker health (/health). |
| All marks failing with 401                     | Re-login (token expired or cleared).                        |
| Mark returns 409 immediately                   | Ticket already used; verify code.                           |
| Repeated 429 responses                         | Slow down scanning (rate limit); wait 1–2s.                 |
| Camera black                                   | Re-allow permissions / try another browser tab.             |

## 6. Rollback Procedure

You can redeploy previous Worker version (needs version id):

```
wrangler versions list
wrangler deploy --version <PREVIOUS_VERSION_ID>
```

(or keep a tagged git commit once remote configured.)

## 7. Health & Stats

- Health Check: GET /health -> `{ok:true, ts}` (no auth) for uptime monitors.
- Stats Dashboard: GET /stats (Bearer) -> totals + per-hour buckets (default 6h window).
  - Optional window param: /stats?window=24h

## 8. Cron Sheet Sync

- Runs every 2 minutes. New rows appear in D1 automatically.
- To verify quickly: Query with D1 execute command in acceptance doc.

## 9. Common Error Codes

| code         | Meaning                            |
| ------------ | ---------------------------------- |
| UNAUTHORIZED | Missing / invalid token            |
| NOT_FOUND    | Ticket not found                   |
| ALREADY_USED | Ticket already consumed            |
| RATE_LIMIT   | Too many requests from this IP     |
| DEBOUNCE     | Duplicate rapid request suppressed |
| INVALID_BODY | Malformed JSON input               |

## 10. Pre-Event Checklist

- [ ] Latest Worker deployed (record version id)
- [ ] Stats endpoint returns expected totals
- [ ] Gate device cameras tested
- [ ] Monitor screen visible & receiving USED broadcasts
- [ ] Network stable on venue Wi-Fi / fallback mobile hotspot available

## 11. Post-Event

- Export used tickets via SQL: `SELECT code,name,email,used_at FROM tickets WHERE used=1 ORDER BY used_at;`
- Archive logs if needed (extend Worker to store) – currently ephemeral.

## 12. Escalation

- If D1 errors persist: attempt redeploy; if still failing, open Cloudflare dashboard for DB status.
- For credential reset: update admins table password hash (PBKDF2) and redeploy if env constants needed.

---

End of RUNBOOK.

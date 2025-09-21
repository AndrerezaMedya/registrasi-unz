# Changelog

## v0.9.0 (Unreleased)

### Added

- Standardized error response helper `stdError` returning `{ ok:false, code, error, message, ts }` for all API errors.
- JSON `/health` endpoint with version, uptime (ms), current timestamp.
- `/stats?window=<hours>` parameter (1–48, default 6) with per-window caching; response now includes `window_hours`.
- WebSocket heartbeat (client ping every 20s, server responds `pong`; client closes after 45s silence) for both gate and monitor apps.
- Durable Object ring buffer of last 50 check-in events; snapshot (`{type:'snapshot', events:[...]}`) sent immediately on connection.

### Changed

- Unauthorized WebSocket upgrade now returns JSON error via unified error helper.
- Error messages now include a human-readable `message` field while preserving legacy `error` code for backward compatibility.

### Fixed

- Ensured consistent CORS + error shapes across endpoints (`/login`, `/validate`, `/mark-used`, `/stats`, `/sync-now`).

### Notes

- Version set to `v0.9.0` internally; bump to `1.0.0` after production validation.
- Snapshot events are not persisted beyond the in-memory isolate lifetime; acceptable for operational monitoring use-case.
- Existing clients that relied only on `error` field continue to function.

---

Previous versions not tracked in this changelog (initial introduction, Sheets sync reliability improvements, multi-sheet support, throttled inserts, etc.).

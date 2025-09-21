import { TicketRow, Env } from './types';
import { jsonResponse, stdError, getIP, handleCorsPreflight, readBody, readJsonLoose, DebounceMap } from './utils';

// Existing code...

// Simple token bucket per IP
class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  constructor(private capacity: number, private refillPerSec: number) {}
  allow(ip: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ip) || { tokens: this.capacity, last: now };
    const delta = (now - bucket.last) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + delta * this.refillPerSec);
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(ip, bucket);
      return true;
    }
    this.buckets.set(ip, bucket);
    return false;
  }
}

// (stdError, readBody, readJsonLoose moved to utils.ts)

const rateLimiter = new RateLimiter(5, 5); // 5 req capacity, refill 5/s
const debounce = new DebounceMap(500);

async function handleValidate(code: string, env: Env) {
  const stmt = env.DB.prepare('SELECT name,email,code,used,used_at FROM tickets WHERE code=?');
  const res = await stmt.bind(code).first<TicketRow>();
  if (!res) return { status: 404, body: { ok: false, error: 'NOT_FOUND' } };
  return { status: 200, body: { ok: true, used: !!res.used, name: res.name, email: res.email, used_at: res.used_at } };
}

async function handleMarkUsed(code: string, admin_id: string, env: Env) {
  const update = await env.DB.prepare(
    'UPDATE tickets SET used=1, used_at=CURRENT_TIMESTAMP WHERE code=? AND used=0'
  ).bind(code).run();
  if (update.success && update.meta.changes === 1) {
    const row = await env.DB.prepare('SELECT name,email,code,used_at FROM tickets WHERE code=?').bind(code).first<TicketRow>();
    // Broadcast (best-effort) via Durable Object
    if (row) {
      try {
        const id = env.CHECKIN_HUB.idFromName(admin_id);
        const stub = env.CHECKIN_HUB.get(id);
        await stub.fetch('https://do/broadcast', { method: 'POST', body: JSON.stringify({ code, name: row.name, used_at: row.used_at, result: 'USED' }) });
      } catch { /* ignore */ }
    }
    return { status: 200, body: { ok: true, result: 'USED', code } };
  } else if (update.success) {
    return { status: 409, body: { ok: false, error: 'ALREADY_USED' } };
  }
  return { status: 500, body: { ok: false, error: 'DB_ERROR' } };
}

// getIP moved to utils.ts

// (handleCorsPreflight and Env moved to utils/types modules)

// ================= JWT & Auth Helpers =================
interface AdminRow { id: string; username: string; password_hash: string; name: string; role?: string; }

// Legacy helper (not used for current verification, kept for potential future admin creation tooling)
async function hashPassword(_pw: string): Promise<string> { throw new Error('Use external PBKDF2 generator'); }

/**
 * Verify password against stored format: pbkdf2$<saltB64>$<hashB64>
 * - PBKDF2-HMAC-SHA256
 * - iterations: 100,000
 * - key length: 32 bytes (256 bits)
 */
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    if (!stored.startsWith('pbkdf2$')) return false;
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const saltB64 = parts[1];
    const hashB64 = parts[2];
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pw), { name: 'PBKDF2' }, false, ['deriveBits']);
    const saltBytes = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 100_000 }, keyMaterial, 256);
    const derivedB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
    if (derivedB64.length !== hashB64.length) return false;
    // constant-time compare
    let diff = 0;
    for (let i = 0; i < derivedB64.length; i++) diff |= derivedB64.charCodeAt(i) ^ hashB64.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function signJWT(payload: any, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b64 = (obj: any) => base64UrlEncode(encoder.encode(JSON.stringify(obj)));
  const unsigned = b64(header) + '.' + b64(payload);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned));
  return unsigned + '.' + base64UrlEncode(sig);
}

async function verifyJWT(token: string, secret: string): Promise<any|null> {
  const [h,p,s] = token.split('.'); if (!h||!p||!s) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
  const data = h + '.' + p;
  const sig = Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(data));
  if (!valid) return null;
  const payloadJson = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0))));
  if (payloadJson.exp && Date.now()/1000 > payloadJson.exp) return null;
  return payloadJson;
}

async function getAdminByUsername(username: string, env: Env): Promise<AdminRow|null> {
  const row = await env.DB.prepare('SELECT id,username,password_hash,name,role FROM admins WHERE username=?').bind(username).first<AdminRow>();
  return row || null;
}

async function bearerAuth(request: Request, env: Env): Promise<{admin_id:string}|{error:string}> {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    const payload = await verifyJWT(token, env.GATE_JWT_SECRET).catch(()=>null);
    if (payload && payload.admin_id) return { admin_id: payload.admin_id };
    return { error: 'INVALID_TOKEN' };
  }
  // fallback x-gate-key for internal scripts
  const key = request.headers.get('x-gate-key');
  if (key && key === env.GATE_API_KEY) return { admin_id: 'internal' };
  return { error: 'UNAUTHORIZED' };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsOrigin = env.CORS_ORIGIN;
    // Initialize global app start (once per isolate)
    if (!(globalThis as any).__appStart) {
      (globalThis as any).__appStart = Date.now();
    }

    const eventClosed = env.EVENT_CLOSED === '1';

    // WebSocket upgrade path (proxy to DO): /ws?token=... (disabled if closed)
    if (url.pathname === '/ws') {
      if (eventClosed) return stdError('EVENT_CLOSED','Event closed', undefined, 410, corsOrigin);
      let admin_id: string | null = null;
      const tokenParam = url.searchParams.get('token');
      if (tokenParam) {
        const payload = await verifyJWT(tokenParam, env.GATE_JWT_SECRET).catch(()=>null);
        if (payload?.admin_id) admin_id = payload.admin_id;
      }
      if (!admin_id) {
        const authRes = await bearerAuth(request, env);
        if ('error' in authRes) return stdError('UNAUTHORIZED', 'Unauthorized', undefined, 401, corsOrigin);
        admin_id = authRes.admin_id;
      }
      const id = env.CHECKIN_HUB.idFromName(admin_id);
      const stub = env.CHECKIN_HUB.get(id);
      return stub.fetch('https://do/ws', request);
    }

    const pre = handleCorsPreflight(request, corsOrigin);
    if (pre) return pre;

    // Allow requests from primary CORS origin (Firebase hosting) AND self origin (so /dashboard can live on worker domain)
    const origin = request.headers.get('Origin');
    const selfOrigin = url.origin;
    if (origin && origin !== corsOrigin && origin !== selfOrigin) {
      return new Response('Origin not allowed', { status: 403 });
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      if (eventClosed) return stdError('EVENT_CLOSED','Event closed (read-only)', undefined, 410, corsOrigin);
      const body = await readJsonLoose(request) as {username?:string; password?:string} | null;
      if (!body?.username || !body?.password) {
        return stdError('MISSING_CREDENTIALS', 'Username & password required', undefined, 400, corsOrigin);
      }
      const admin = await getAdminByUsername(body.username, env);
      if (!admin || !admin.password_hash) return stdError('INVALID_LOGIN', 'Invalid username or password', undefined, 401, corsOrigin);
      const passOk = await verifyPassword(body.password, admin.password_hash);
      if (!passOk) return stdError('INVALID_LOGIN', 'Invalid username or password', undefined, 401, corsOrigin);
      const exp = Math.floor(Date.now()/1000) + 60*60*12; // 12h
  const token = await signJWT({ admin_id: admin.id, role: admin.role || 'staff', exp }, env.GATE_JWT_SECRET);
  return jsonResponse({ ok:true, admin_id: admin.id, role: admin.role || 'staff', token }, 200, corsOrigin);
    }

    if (url.pathname === '/validate' && request.method === 'POST') {
      if (eventClosed) return stdError('EVENT_CLOSED','Event closed', undefined, 410, corsOrigin);
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);
      const body = await readBody<{ code?: string }>(request);
      if (!body?.code) return stdError('MISSING_CODE', 'Missing code', undefined, 400, corsOrigin);
      const res = await handleValidate(body.code.trim(), env);
      return jsonResponse(res.body, res.status, corsOrigin);
    }

    if (url.pathname === '/mark-used' && request.method === 'POST') {
      if (eventClosed) return stdError('EVENT_CLOSED','Event closed', undefined, 410, corsOrigin);
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);

      const ip = getIP(request);
      if (!rateLimiter.allow(ip)) return stdError('RATE_LIMIT', 'Too many requests', undefined, 429, corsOrigin);

      const body = await readBody<{ code?: string; admin_id?: string }>(request);
      if (!body?.code) return stdError('MISSING_CODE', 'Missing code', undefined, 400, corsOrigin);
      const code = body.code.trim();
      if (!debounce.check(code)) return stdError('DEBOUNCE', 'Duplicate rapid submission', undefined, 429, corsOrigin);
      const admin_id = (body.admin_id || (authRes as any).admin_id || 'unknown').slice(0, 64);
      const res = await handleMarkUsed(code, admin_id, env);

      // Minimal log (fire and forget)
      ctx.waitUntil((async () => {
        try {
          await env.DB.prepare('INSERT INTO logs(ts,code,admin_id,result) VALUES(CURRENT_TIMESTAMP,?,?,?)')
            .bind(code, admin_id, res.body.error ? String(res.body.error) : 'OK')
            .run();
        } catch { /* ignore */ }
      })());

      return jsonResponse(res.body, res.status, corsOrigin);
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);
      // window parameter (hours) default 6, min 1, max 48
      let windowParam = parseInt(url.searchParams.get('window') || '6', 10);
      if (isNaN(windowParam) || windowParam < 1) windowParam = 6;
      if (windowParam > 48) windowParam = 48;
      const now = Date.now();
      // Cache structure keyed by window size
      // @ts-ignore
      if (!(globalThis as any).__statsCacheMap) (globalThis as any).__statsCacheMap = new Map<number,{t:number;payload:any}>();
      // @ts-ignore
      const cacheMap: Map<number,{t:number;payload:any}> = (globalThis as any).__statsCacheMap;
      const existing = cacheMap.get(windowParam);
      if (existing && (now - existing.t) < 10_000) {
        return jsonResponse(existing.payload, 200, corsOrigin);
      }
      const totalRow = await env.DB.prepare("SELECT COUNT(*) c FROM tickets").first<{c:number}>();
      const usedRow = await env.DB.prepare("SELECT COUNT(*) c FROM tickets WHERE used=1").first<{c:number}>();
      const lastHourRow = await env.DB.prepare("SELECT COUNT(*) c FROM tickets WHERE used=1 AND used_at >= DATETIME('now','-60 minutes')").first<{c:number}>();
      const perHour = await env.DB.prepare(`SELECT STRFTIME('%Y-%m-%dT%H:00:00Z', used_at) hour_bucket, COUNT(*) used FROM tickets WHERE used=1 AND used_at >= DATETIME('now', ? ) GROUP BY hour_bucket ORDER BY hour_bucket`).bind(`-${windowParam} hours`).all<{hour_bucket:string; used:number}>();
      const total = totalRow?.c || 0;
      const used = usedRow?.c || 0;
      const payload = {
        ok: true,
        total,
        used,
        unused: total - used,
        last_hour: lastHourRow?.c || 0,
        window_hours: windowParam,
        per_hour: (perHour.results || []).map(r => ({ hour: r.hour_bucket, used: r.used }))
      };
      cacheMap.set(windowParam, { t: now, payload });
      return jsonResponse(payload, 200, corsOrigin);
    }

    // List checked-in participants (JSON). Supports ?limit=100&offset=0&q=search&export=csv
    if (url.pathname === '/checked-in' && request.method === 'GET') {
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);
      let limit = parseInt(url.searchParams.get('limit') || '100', 10);
      if (isNaN(limit) || limit < 1) limit = 50; if (limit > 500) limit = 500;
      let offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (isNaN(offset) || offset < 0) offset = 0;
      const q = (url.searchParams.get('q') || '').trim();
      const exportCsv = url.searchParams.get('export') === 'csv';
      // Build WHERE clause
      let where = 'used=1';
      const params: any[] = [];
      if (q) {
        where += ' AND (code LIKE ? OR lower(name) LIKE lower(?) OR lower(email) LIKE lower(?))';
        const pat = `%${q}%`;
        params.push(pat, pat, pat);
      }
      // Count total used (with filter)
      const countStmt = env.DB.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${where}`).bind(...params);
      const countRow = await countStmt.first<{c:number}>();
      const rowsStmt = env.DB.prepare(`SELECT code,name,email,wa,used_at FROM tickets WHERE ${where} ORDER BY used_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset);
      const rowsRes = await rowsStmt.all<{code:string; name:string; email:string; wa:string|null; used_at:string}>();
      const rows = (rowsRes.results||[]).map(r=>({ code: r.code, name: r.name, email: r.email, wa: r.wa, used_at: r.used_at }));
      if (exportCsv) {
        const header = 'code,name,email,wa,used_at\n';
        const body = rows.map(r=> [r.code, r.name?.replace(/,/g,' '), r.email?.replace(/,/g,' '), (r.wa||'').replace(/,/g,' '), r.used_at].join(',')).join('\n');
        return new Response(header+body, { status: 200, headers: { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="checked-in.csv"' } });
      }
      return jsonResponse({ ok:true, total: countRow?.c || 0, count: rows.length, limit, offset, q, rows }, 200, corsOrigin);
    }

    // Generic participants listing: /participants?used=1 or used=0 (default all) with pagination/search/export
    if (url.pathname === '/participants' && request.method === 'GET') {
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);
      let limit = parseInt(url.searchParams.get('limit') || '100', 10);
      if (isNaN(limit) || limit < 1) limit = 50; if (limit > 500) limit = 500;
      let offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (isNaN(offset) || offset < 0) offset = 0;
      const usedParam = url.searchParams.get('used'); // '1' or '0' or null
      const q = (url.searchParams.get('q') || '').trim();
      const exportCsv = url.searchParams.get('export') === 'csv';
      let where = '1=1';
      const params: any[] = [];
      if (usedParam === '1') where += ' AND used=1';
      else if (usedParam === '0') where += ' AND used=0';
      if (q) {
        where += ' AND (code LIKE ? OR lower(name) LIKE lower(?) OR lower(email) LIKE lower(?))';
        const pat = `%${q}%`;
        params.push(pat, pat, pat);
      }
      const countStmt = env.DB.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${where}`).bind(...params);
      const countRow = await countStmt.first<{c:number}>();
      const rowsStmt = env.DB.prepare(`SELECT code,name,email,wa,used,used_at FROM tickets WHERE ${where} ORDER BY used DESC, used_at DESC NULLS LAST, code ASC LIMIT ? OFFSET ?`).bind(...params, limit, offset);
      const rowsRes = await rowsStmt.all<{code:string; name:string; email:string; wa:string|null; used:number; used_at:string|null}>();
      const rows = (rowsRes.results||[]).map(r=>({ code:r.code, name:r.name, email:r.email, wa:r.wa, used: !!r.used, used_at: r.used_at }));
      if (exportCsv) {
        const header = 'code,name,email,wa,used,used_at\n';
        const body = rows.map(r=> [r.code, (r.name||'').replace(/,/g,' '), (r.email||'').replace(/,/g,' '), (r.wa||'').replace(/,/g,' '), r.used? '1':'0', r.used_at||'' ].join(',')).join('\n');
        return new Response(header+body, { status:200, headers: { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="participants.csv"' } });
      }
      return jsonResponse({ ok:true, total: countRow?.c||0, count: rows.length, limit, offset, used: usedParam, q, rows }, 200, corsOrigin);
    }

    // All unused participants (no pagination) for dashboard convenience: /participants-unused?export=csv&q=search
    if (url.pathname === '/participants-unused' && request.method === 'GET') {
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);
      const q = (url.searchParams.get('q') || '').trim();
      const exportCsv = url.searchParams.get('export') === 'csv';
      let where = 'used=0';
      const params: any[] = [];
      if (q) { where += ' AND (code LIKE ? OR lower(name) LIKE lower(?) OR lower(email) LIKE lower(?))'; const pat = `%${q}%`; params.push(pat, pat, pat); }
      // Hard cap to avoid memory blow (adjust if needed)
      const CAP = 5000;
      const rowsStmt = env.DB.prepare(`SELECT code,name,email,wa FROM tickets WHERE ${where} ORDER BY code ASC LIMIT ${CAP+1}`).bind(...params);
      const rowsRes = await rowsStmt.all<{code:string; name:string; email:string; wa:string|null}>();
      const overCap = (rowsRes.results||[]).length > CAP;
      const rows = (rowsRes.results||[]).slice(0, CAP).map(r=>({ code:r.code, name:r.name, email:r.email, wa:r.wa }));
      if (exportCsv) {
        const header = 'code,name,email,wa\n';
        const body = rows.map(r=> [r.code,(r.name||'').replace(/,/g,' '),(r.email||'').replace(/,/g,' '),(r.wa||'').replace(/,/g,' ')].join(',')).join('\n');
        return new Response(header+body, { status:200, headers:{ 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="participants-unused.csv"' }});
      }
      return jsonResponse({ ok:true, count: rows.length, capped: overCap, cap: CAP, q, rows }, 200, corsOrigin);
    }

    // Simple HTML dashboard (served from worker) that consumes /checked-in
    if ((url.pathname === '/dashboard' || url.pathname === '/dashboard/' || url.pathname === '/dashboard/index.html') && request.method === 'GET') {
      const html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"/>
<title>Dashboard Check-in</title><meta name="viewport" content="width=device-width,initial-scale=1" />
<style>body{font-family:system-ui,Arial,sans-serif;margin:0;background:#101416;color:#e8e8e8;}
header{background:#182028;padding:10px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:12px}
h1{font-size:1.1rem;margin:0;font-weight:600;letter-spacing:.5px}
button,input{font:inherit}input[type=text],input[type=password]{padding:6px 8px;border:1px solid #334;border-radius:4px;background:#121a22;color:#eee}
button{padding:6px 12px;border:1px solid #2d5575;border-radius:4px;background:#25649a;color:#fff;cursor:pointer;font-weight:600}
button.secondary{background:#303b44;border-color:#3d4b58}
button.danger{background:#7a2a2a;border-color:#a33}table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{padding:6px 8px;border-bottom:1px solid #223}th{background:#182028;text-align:left;position:sticky;top:0;font-weight:600}
tbody tr:nth-child(even){background:#151b21}tbody tr:hover{background:#1e2831}
.status{font-size:.7rem;margin-left:auto;padding:4px 8px;border-radius:4px;background:#222}
.ok{background:#0f4d2f}.warn{background:#614d12}.err{background:#6b1d1d}
#loginBox{display:flex;gap:6px}#dataBox{display:none;flex-direction:column;gap:10px;width:100%;}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
footer{padding:10px 14px;font-size:.65rem;opacity:.6}
.pill{background:#243544;padding:2px 6px;border-radius:12px;font-size:.65rem}
.flex{display:flex;align-items:center;gap:6px}
.grow{flex:1}
@media (max-width:640px){th,td{padding:4px 6px;font-size:.68rem}header{gap:6px}}
</style></head><body>
<header>
  <h1>Dashboard Check-in</h1>
  ${eventClosed ? '<div style="font-size:.65rem;background:#5a2a2a;padding:4px 8px;border-radius:4px;letter-spacing:.5px">EVENT FROZEN / READ-ONLY</div>' : ''}
  <div id="loginBox">
    <input id="user" placeholder="username" autocomplete="username" />
    <input id="pass" type="password" placeholder="password" autocomplete="current-password" />
    <button id="loginBtn">Masuk</button>
  </div>
  <div id="sessionBox" style="display:none;gap:8px;align-items:center">
    <span id="sessInfo" class="pill"></span>
    <button id="logoutBtn" class="secondary">Keluar</button>
  </div>
  <div id="status" class="status">idle</div>
</header>
<main style="padding:12px 14px;display:flex;flex-direction:column;gap:14px;">
  <div id="dataBox">
    <div class="bar">
      <div class="flex" style="gap:4px">
        <input id="search" placeholder="Cari kode / nama / email" style="min-width:220px" />
        <button id="searchBtn">Cari</button>
        <button id="clearBtn" class="secondary">Reset</button>
      </div>
      <div class="flex" style="margin-left:auto;gap:4px">
        <button id="modeBtn" class="secondary" title="Tampilkan belum check-in">Mode: Sudah ✓</button>
        <button id="refreshBtn" title="Muat ulang (r)">Reload</button>
        <button id="csvBtn" class="secondary">Export CSV</button>
      </div>
    </div>
    <div style="font-size:.7rem;opacity:.75" id="metaLine">&nbsp;</div>
    <div style="overflow:auto;max-height:70vh;border:1px solid #223;border-radius:6px;">
      <table id="tbl"><thead><tr><th style="width:120px">Waktu</th><th>Kode</th><th>Nama</th><th>Email</th><th>WA</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="bar">
      <div class="flex" style="gap:6px">
        <button id="prevBtn" class="secondary">&laquo; Prev</button>
        <button id="nextBtn" class="secondary">Next &raquo;</button>
        <span id="pageInfo" style="font-size:.7rem;opacity:.7"></span>
      </div>
      <label style="font-size:.65rem;opacity:.7">Limit <input id="limit" type="number" value="100" min="10" max="500" style="width:70px" /></label>
      <label style="font-size:.65rem;opacity:.7">Auto <input id="auto" type="checkbox" checked /></label>
      <span id="autoInfo" style="font-size:.65rem;opacity:.55">Refresh 15s</span>
    </div>
  </div>
</main>
<footer>Dashboard sederhana – v1.0</footer>
<script>const API_BASE=''; const EVENT_CLOSED=${eventClosed? 'true':'false'}; // same origin
const els={u:document.getElementById('user'),p:document.getElementById('pass'),login:document.getElementById('loginBtn'),status:document.getElementById('status'),tbl:document.querySelector('#tbl tbody'),loginBox:document.getElementById('loginBox'),dataBox:document.getElementById('dataBox'),sess:document.getElementById('sessInfo'),sessBox:document.getElementById('sessionBox'),logout:document.getElementById('logoutBtn'),search:document.getElementById('search'),searchBtn:document.getElementById('searchBtn'),clearBtn:document.getElementById('clearBtn'),refresh:document.getElementById('refreshBtn'),csv:document.getElementById('csvBtn'),prev:document.getElementById('prevBtn'),next:document.getElementById('nextBtn'),pageInfo:document.getElementById('pageInfo'),limit:document.getElementById('limit'),auto:document.getElementById('auto'),autoInfo:document.getElementById('autoInfo'),meta:document.getElementById('metaLine'),modeBtn:document.getElementById('modeBtn')};
let token=null; let adminId=null; let offset=0; let total=0; let q=''; let timer=null; let showUsed=true; // true = show checked-in, false = show belum
let unusedCache=null;
function setStatus(t,c){els.status.textContent=t;els.status.className='status '+(c||'');}
function save(){localStorage.setItem('dashAuth',JSON.stringify({token,adminId}));}
function load(){try{const j=JSON.parse(localStorage.getItem('dashAuth')); if(j&&j.token){token=j.token;adminId=j.adminId;return true}}catch{} return false;}
async function login(){if(EVENT_CLOSED){ setStatus('Read-only','warn'); return;} if(!els.u.value||!els.p.value)return; setStatus('login...'); const r=await fetch(API_BASE+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:els.u.value,password:els.p.value})}); const j=await r.json(); if(j.ok){token=j.token;adminId=j.admin_id;save(); els.loginBox.style.display='none'; els.dataBox.style.display='flex'; els.sessBox.style.display='flex'; els.sess.textContent=adminId; setStatus('OK','ok'); offset=0; loadPage(); autoCycle(); } else { setStatus(j.error||'gagal','err'); }}
async function loadPage(){ if(!token) return; els.tbl.innerHTML=''; if(!showUsed){
  // mode belum: ambil semua tanpa pagination
  setStatus('memuat semua belum...'); els.prev.disabled=true; els.next.disabled=true; els.limit.disabled=true;
  const url=new URL(API_BASE+'/participants-unused',location.href); if(q) url.searchParams.set('q',q);
  const r=await fetch(url.toString(),{headers:{'Authorization':'Bearer '+token}});
  if(r.status===401){ setStatus('Sesi habis','warn'); return logout(); }
  const j=await r.json(); if(!j.ok){ setStatus(j.error||'err','err'); return; }
  unusedCache=j; total=j.count; els.tbl.innerHTML='';
  for(const row of j.rows){ const tr=document.createElement('tr'); tr.innerHTML='<td></td><td>'+esc(row.code)+'</td><td>'+esc(row.name||'')+'</td><td>'+esc(row.email||'')+'</td><td>'+esc(row.wa||'')+'</td>'; els.tbl.appendChild(tr); }
  els.pageInfo.textContent='1 / 1'; els.meta.textContent='Total belum: '+j.count + (j.capped? ' (CAP '+j.cap+' tercapai)':''); setStatus('siap'); return; }
  // mode sudah: pagination biasa
  const limit=parseInt(els.limit.value)||100; els.prev.disabled=false; els.next.disabled=false; els.limit.disabled=false; setStatus('memuat'); const url=new URL(API_BASE+'/participants',location.href); url.searchParams.set('limit',limit); url.searchParams.set('offset',offset); url.searchParams.set('used','1'); if(q) url.searchParams.set('q',q); const r=await fetch(url.toString(),{headers:{'Authorization':'Bearer '+token}}); if(r.status===401){ setStatus('Sesi habis','warn'); return logout(); } const j=await r.json(); if(!j.ok){ setStatus(j.error||'err','err'); return; } total=j.total; for(const row of j.rows){ const tr=document.createElement('tr'); const dt=row.used_at? new Date(row.used_at): null; const tstr= dt? dt.toLocaleString():''; tr.innerHTML='<td>'+tstr+'</td><td>'+esc(row.code)+'</td><td>'+esc(row.name||'')+'</td><td>'+esc(row.email||'')+'</td><td>'+esc(row.wa||'')+'</td>'; els.tbl.appendChild(tr);} const page=Math.floor(offset/limit)+1; const pages=Math.max(1,Math.ceil(total/limit)); els.pageInfo.textContent=page+' / '+pages; els.meta.textContent='Total used: '+total+' | Showing '+j.count; setStatus('siap'); }
function esc(s){return (s||'').toString().replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
function logout(){token=null;adminId=null;localStorage.removeItem('dashAuth'); els.loginBox.style.display='flex'; els.dataBox.style.display='none'; els.sessBox.style.display='none'; setStatus('logout'); if(timer) clearTimeout(timer); }
function autoCycle(){ if(!els.auto.checked) return; if(timer) clearTimeout(timer); timer=setTimeout(()=>{ loadPage().then(autoCycle); },15000); }
els.login.addEventListener('click',login); els.p.addEventListener('keydown',e=>{ if(e.key==='Enter') login(); });
els.refresh.addEventListener('click',()=>{ loadPage(); });
els.csv.addEventListener('click',()=>{ if(!token) return; let url; if(showUsed){ url=new URL(API_BASE+'/participants',location.href); url.searchParams.set('limit',els.limit.value||'100'); url.searchParams.set('offset',offset); url.searchParams.set('used','1'); } else { url=new URL(API_BASE+'/participants-unused',location.href); } if(q) url.searchParams.set('q',q); url.searchParams.set('export','csv'); fetch(url.toString(),{headers:{'Authorization':'Bearer '+token}}).then(r=>r.blob()).then(b=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download= showUsed? 'checked-in.csv':'belum-checkin.csv'; a.click(); }); });
els.modeBtn.addEventListener('click',()=>{ showUsed=!showUsed; els.modeBtn.textContent = showUsed? 'Mode: Sudah ✓':'Mode: Belum ✗'; els.modeBtn.title = showUsed? 'Tampilkan belum check-in':'Tampilkan sudah check-in'; offset=0; loadPage(); });
els.prev.addEventListener('click',()=>{ if(!showUsed) return; const limit=parseInt(els.limit.value)||100; offset=Math.max(0, offset - limit); loadPage(); });
els.next.addEventListener('click',()=>{ if(!showUsed) return; const limit=parseInt(els.limit.value)||100; if(offset + limit < total){ offset += limit; loadPage(); }});
els.limit.addEventListener('change',()=>{ offset=0; loadPage(); autoCycle(); });
els.auto.addEventListener('change',()=>{ if(els.auto.checked){ autoCycle(); } else if(timer){ clearTimeout(timer); }});
els.logout.addEventListener('click',logout);
els.searchBtn.addEventListener('click',()=>{ q=els.search.value.trim(); offset=0; loadPage(); });
els.clearBtn.addEventListener('click',()=>{ els.search.value=''; q=''; offset=0; loadPage(); });
document.addEventListener('keydown',e=>{ if(e.key==='r' && !e.metaKey && !e.ctrlKey){ loadPage(); } });
if(load()){ els.loginBox.style.display='none'; els.dataBox.style.display='flex'; els.sessBox.style.display='flex'; els.sess.textContent=adminId; loadPage(); autoCycle(); }
</script></body></html>`;
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // DEBUG: manual trigger sync (will be removed for production). Requires auth.
    if (url.pathname === '/sync-now' && request.method === 'POST') {
      const authRes = await bearerAuth(request, env);
      if ('error' in authRes) return stdError(authRes.error, 'Unauthorized', undefined, 401, corsOrigin);
      try {
        const values = await fetchSheetValues(env);
        const { inserted, updated } = await upsertRows(values, env);
        return jsonResponse({ ok:true, rows: values.length, inserted, updated }, 200, corsOrigin);
      } catch (e:any) {
        return stdError('SYNC_FAIL', 'Sync failed', { detail: e?.message }, 500, corsOrigin);
      }
    }
    // JSON health endpoint
    if (url.pathname === '/health') {
      const uptimeMs = Date.now() - (globalThis as any).__appStart;
      const eventClosed = env.EVENT_CLOSED === '1';
      return jsonResponse({ ok:true, status:'healthy', version:'v0.9.1', mode: eventClosed? 'closed':'open', uptime_ms: uptimeMs, now: new Date().toISOString() }, 200, corsOrigin);
    }

    return new Response('Not Found', { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (env.EVENT_CLOSED === '1') {
      console.log('scheduled: skipped sync (event closed)');
      return;
    }
    try {
      const values = await fetchSheetValues(env);
      const { inserted, updated } = await upsertRows(values, env);
      console.log('sync done', { inserted, updated, rows: values.length });
    } catch (e) {
      console.error('sync error', (e as Error).message);
    }
  }
} satisfies ExportedHandler<Env>;

import CheckinHub from './do/CheckinHub';

async function fetchSheetValues(env: Env): Promise<any[][]> {
  // We support two secret formats for SHEETS_SA_KEY:
  // 1. Raw PEM string (with BEGIN/END PRIVATE KEY lines, newlines possibly escaped as \n)
  // 2. Full JSON service account file (the entire JSON inserted as the secret)
  // Previous implementation replaced \n BEFORE attempting JSON.parse which corrupted the JSON (converted escaped \n inside the JSON string into literal newlines, making it invalid). That caused us to treat the whole JSON file as a PEM blob and feed non‑base64 characters to atob -> invalid base64.
  let email = env.SHEETS_SA_EMAIL;
  const rawSecret = env.SHEETS_SA_KEY; // do not mutate before JSON parse attempt
  let keyPem: string = '';

  if (rawSecret.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawSecret);
      if (!email && parsed.client_email) email = parsed.client_email;
      if (!parsed.private_key) throw new Error('missing private_key');
      // Now expand escaped newlines inside the JSON field
      keyPem = parsed.private_key.replace(/\\n/g, '\n');
      console.log('cron: secret JSON detected');
    } catch (e) {
      console.log('cron: JSON parse failed', (e as Error).message);
      // Fallback: treat original content as PEM (rare edge case)
      keyPem = rawSecret.replace(/\\n/g, '\n');
    }
  } else {
    keyPem = rawSecret.replace(/\\n/g, '\n');
  }

  console.log('cron: SA email', email);
  console.log('cron: pk length', (keyPem || '').length);
  if (!/BEGIN PRIVATE KEY/.test(keyPem)) {
    console.log('cron: warning – private key does not contain BEGIN PRIVATE KEY header');
  }
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
  const header = { alg: 'RS256', typ: 'JWT' };
  function base64urlStr(str: string){
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  const headerPart = base64urlStr(JSON.stringify(header));
  const payloadPart = base64urlStr(JSON.stringify(claim));
  const data = new TextEncoder().encode(headerPart + '.' + payloadPart);
  const keyObj = await crypto.subtle.importKey('pkcs8', decodeB64(keyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyObj, data);
  const sigB64Url = base64urlBuf(sigBuf);
  const jwt = headerPart + '.' + payloadPart + '.' + sigB64Url;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString() });
  if (!tokenResp.ok) throw new Error('token');
  const tokenJson = await tokenResp.json<any>();
  const accessToken = tokenJson.access_token;
  // Support multiple sheet tabs: SHEET_NAME can be comma-separated e.g. "participants,audience"
  const sheets = env.SHEET_NAME.split(',').map(s=>s.trim()).filter(Boolean);
  const all: any[][] = [];
  let masterHeader: string[] | null = null;
  for (const sheetName of sheets) {
    const range = encodeURIComponent(sheetName + '!A:E');
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${range}`;
    const sheetResp = await fetch(sheetUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!sheetResp.ok) { console.log('cron: sheet fetch failed', sheetName, sheetResp.status); continue; }
    const sheetJson = await sheetResp.json<any>();
    const values = sheetJson.values || [];
    if (!values.length) continue;
    if (!masterHeader) {
      masterHeader = values[0];
  all.push((masterHeader as string[]).slice());
    }
    // Assume header row present; append data rows. Normalize width to masterHeader length.
    for (let i=1;i<values.length;i++) {
      const row = values[i];
  const normalized = (masterHeader as string[]).map((_,idx)=> row[idx] || '');
      all.push(normalized);
    }
  }
  return all;
}

function decodeB64(b64: string): Uint8Array {
  const cleaned = b64
    .replace(/-----BEGIN [^-]+-----/g,'')
    .replace(/-----END [^-]+-----/g,'')
    .replace(/\s+/g,'')
    .replace(/-/g,'+')
    .replace(/_/g,'/');
  const pad = cleaned.length % 4 === 0 ? 0 : 4 - (cleaned.length % 4);
  const padded = cleaned + '='.repeat(pad);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function base64urlBuf(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin=''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function upsertRows(values: any[][], env: Env) {
  if (!values.length) return { inserted:0, updated:0 };
  const header = values[0].map((h: string)=>h.toLowerCase().trim());
  // Support multiple possible column names from the sheet
  const findIdx = (candidates: string[]) => {
    for (const c of candidates) { const i = header.indexOf(c); if (i>=0) return i; }
    return -1;
  };
  const idxName = findIdx(['name','full_name']);
  const idxEmail = findIdx(['email','e-mail']);
  const idxCode = findIdx(['code','ticket_code']);
  const idxQr = findIdx(['qr_url','qr']);
  const idxWa = findIdx(['wa','wa_number','whatsapp','whatsapp_number']);
  const rows: {code:string; name:string; email:string; qr:string|null; wa:string|null}[] = [];
  for (let i=1;i<values.length;i++) {
    const row = values[i];
    const code = row[idxCode];
    if (!code) continue;
    rows.push({
      code,
      name: (idxName>=0? row[idxName]: '') || '',
      email: (idxEmail>=0? row[idxEmail]: '') || '',
      qr: idxQr>=0? (row[idxQr]||null) : null,
      wa: idxWa>=0? (row[idxWa]||null) : null
    });
  }
  if (!rows.length) return { inserted:0, updated:0 };

  // Fetch existing codes (and current name/email) in small chunks to decide if we should update
  const existing = new Map<string,{name:string; email:string; wa:string|null; qr_url:string|null}>();
  const selectChunk = 40;
  for (let i=0;i<rows.length;i+=selectChunk) {
    const chunk = rows.slice(i, i+selectChunk);
    const placeholders = chunk.map(()=>'?').join(',');
    const stmt = env.DB.prepare(`SELECT code,name,email,wa,qr_url FROM tickets WHERE code IN (${placeholders})`).bind(...chunk.map(r=>r.code));
    const res = await stmt.all<{code:string; name:string; email:string; wa:string|null; qr_url:string|null}>();
    for (const r of res.results || []) existing.set(r.code, { name: r.name||'', email: r.email||'', wa: r.wa||null, qr_url: r.qr_url||null });
  }

  // Insert ONLY new codes to minimize number of statements (skips updates to existing rows)
  let inserted = 0; let updated = 0;
  const insertSingle = async (r: typeof rows[number]) => {
    try {
      await env.DB.prepare(`INSERT INTO tickets(name,email,wa,code,qr_url) VALUES(?,?,?,?,?)`).bind(r.name, r.email, r.wa, r.code, r.qr).run();
      inserted++;
    } catch {/* ignore if conflict raced */}
  };
  // Process new codes with a cap to avoid exceeding subrequest limits per invocation (e.g., 30 inserts max)
  const MAX_INSERTS = 30;
  // Strategy:
  // - Insert up to MAX_INSERTS new codes (as before)
  // - Light update: if existing name/email shorter than new (indicating we previously stored only first segment)
  //                or empty fields now have data, update (capped to MAX_UPDATES to avoid large writes)
  const MAX_UPDATES = 30;
  for (const r of rows) {
    const ex = existing.get(r.code);
    if (!ex) {
      if (inserted < MAX_INSERTS) await insertSingle(r);
      continue;
    }
    if (updated >= MAX_UPDATES) continue;
    const needName = r.name && r.name.length > ex.name.length; // longer name -> likely full name now available
    const needEmail = r.email && r.email !== ex.email;
    const needWa = r.wa && r.wa !== ex.wa;
    const needQr = r.qr && r.qr !== ex.qr_url;
    if (needName || needEmail || needWa || needQr) {
      try {
        await env.DB.prepare(`UPDATE tickets SET name=COALESCE(?,name), email=COALESCE(?,email), wa=COALESCE(?,wa), qr_url=COALESCE(?,qr_url) WHERE code=?`)
          .bind(needName? r.name: null, needEmail? r.email: null, needWa? r.wa: null, needQr? r.qr: null, r.code).run();
        updated++;
      } catch { /* ignore */ }
    }
  }
  return { inserted, updated };
}

// End of helper functions

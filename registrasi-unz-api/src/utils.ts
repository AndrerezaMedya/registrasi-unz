// Debounce / duplicate fast submissions (500ms window)
export class DebounceMap {
	private map = new Map<string, number>();
	constructor(private ttlMs: number) {}
	check(code: string): boolean {
		const now = Date.now();
		const prev = this.map.get(code);
		if (prev && now - prev < this.ttlMs) return false; // reject
		this.map.set(code, now);
		return true;
	}
}
// Utility helpers: jsonResponse, stdError, getIP, handleCorsPreflight, readBody, readJsonLoose

export function jsonResponse(obj: any, status = 200, corsOrigin?: string) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' } : {}),
		},
	});
}

export function stdError(code: string, message?: string, extra?: Record<string, any>, status: number = 400, corsOrigin?: string) {
	const body = { ok: false, code, error: code, message: message || code, ts: new Date().toISOString(), ...(extra || {}) };
	return jsonResponse(body, status, corsOrigin);
}

export function getIP(req: Request): string { return req.headers.get('CF-Connecting-IP') || '0.0.0.0'; }

export function handleCorsPreflight(req: Request, corsOrigin: string) {
	if (req.method === 'OPTIONS') {
		const reqHeaders = req.headers.get('Access-Control-Request-Headers') || '';
		// Include Authorization so browser will allow Bearer tokens from gate/monitor frontend
		return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-gate-key', 'Access-Control-Max-Age': '86400' } });
	}
	return null;
}

export async function readBody<T>(req: Request): Promise<T | null> {
	try { return await req.json<T>(); } catch { return null; }
}

export async function readJsonLoose(req: Request): Promise<any> {
	// Clone because other helpers might want to read body later (defensive)
	const clone = req.clone();
	try {
		return await clone.json();
	} catch {
		// Fallback: read text and attempt JSON / form decoding
		try {
			const txt = await clone.text();
			if (!txt) return null;
			// Try JSON again (maybe minor BOM)
			try { return JSON.parse(txt); } catch {}
			// Try key=value&key2=value2
			if (txt.includes('=') && !txt.includes('{')) {
				const obj: Record<string,string> = {};
				for (const part of txt.split('&')) {
					const [k,v] = part.split('=');
						if (k) obj[decodeURIComponent(k)] = decodeURIComponent(v||'');
				}
				return obj;
			}
			return null;
		} catch { return null; }
	}
}
// Utility helpers: jsonResponse, stdError, getIP, handleCorsPreflight, readBody, readJsonLoose

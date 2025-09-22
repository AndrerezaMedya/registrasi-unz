import { Env } from '../types.js';

export interface CheckinMessage {
  code: string;
  name?: string;
  used_at?: string;
  result?: string; // e.g. USED
}

/**
 * Durable Object to broadcast check-in events per admin room.
 * One DO instance (id) will handle many admin rooms via subMaps.
 * Simpler: create a unique DO id per admin_id (the Worker will derive it) so
 * this class only manages one room.
 */
export class CheckinHub implements DurableObject {
  private sockets: Set<WebSocket> = new Set();
  private recent: CheckinMessage[] = []; // ring buffer of last 50 events
  private static MAX_RECENT = 50;
  constructor(private state: DurableObjectState, private env: Env) {}

  /** Broadcast JSON to all active sockets, pruning closed ones. */
  private broadcast(obj: CheckinMessage) {
    const msg = JSON.stringify(obj);
    for (const ws of [...this.sockets]) {
      try {
        ws.send(msg);
      } catch (_) {
        this.sockets.delete(ws);
      }
    }
    // store in ring buffer
    this.recent.push(obj);
    if (this.recent.length > CheckinHub.MAX_RECENT) this.recent.splice(0, this.recent.length - CheckinHub.MAX_RECENT);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.env.EVENT_CLOSED === '1') {
      console.log(`[DO FREEZE] Blocking DO request for ${url.pathname}`);
      return new Response('Event closed', { status: 410 });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 400 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
      this.sockets.add(server);
      // Send snapshot of recent events
      try { server.send(JSON.stringify({ type:'snapshot', events: this.recent })); } catch {}
      // Heartbeat: respond to ping, and send periodic server pings if desired (client drives for now)
      server.addEventListener('message', (ev: MessageEvent) => {
        try {
          if (ev.data === 'ping') {
            server.send('pong');
          }
        } catch {}
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // POST /broadcast {code,name,used_at,result}
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const data = await request.json<CheckinMessage>().catch(() => ({} as CheckinMessage));
      console.log(`[DO] Handling /broadcast for code: ${data.code}`);
      if (!data.code) return new Response('Missing code', { status: 400 });
      this.broadcast(data);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  }
}

export default CheckinHub;

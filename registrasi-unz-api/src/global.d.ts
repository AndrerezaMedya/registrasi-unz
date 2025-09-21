// Minimal ambient declarations to satisfy ESLint/TS for Cloudflare Workers runtime
// For more complete types, run: npm run cf-typegen (Wrangler) which generates worker-env.d.ts

// D1
interface D1ExecResult { success: boolean; error?: any; meta: { changes: number } }
interface D1PreparedStatement<T = unknown> {
  bind(...values: any[]): D1PreparedStatement<T>;
  first<R = T>(): Promise<R | null>;
  run(): Promise<D1ExecResult>;
  all<R = T>(): Promise<{ results: R[] }>;
}
interface D1Database {
  prepare<T = unknown>(query: string): D1PreparedStatement<T>;
}

// Durable Objects
interface DurableObjectState { storage: unknown; }
interface DurableObject {
  fetch(request: Request): Promise<Response> | Response;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ScheduledController { scheduledTime: number; cron: string; }
interface ExecutionContext { waitUntil(p: Promise<any>): void; passThroughOnException(): void; }

// Exported handler shape per CF Workers
interface ExportedHandler<E = any> {
  fetch?: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> | Response;
  scheduled?: (event: ScheduledController, env: E, ctx: ExecutionContext) => Promise<void> | void;
}

// Env interface is defined in index.ts; re-open module to allow global reference
// (If cf-typegen is used, this file can be removed.)
// declare interface Env {}

export {};
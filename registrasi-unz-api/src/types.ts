// Shared types: TicketRow, Env, etc.

export interface TicketRow {
	id?: number;
	name: string;
	email: string;
	wa?: string | null;
	code: string;
	used: number;
	used_at?: string | null;
	qr_url?: string | null;
}

export interface Env {
	DB: D1Database;
	CHECKIN_HUB: DurableObjectNamespace;
	CORS_ORIGIN: string;
	GATE_API_KEY: string;
	GATE_JWT_SECRET: string;
	SHEET_ID: string;
	SHEET_NAME: string;
	SHEETS_SA_EMAIL: string;
	SHEETS_SA_KEY: string;
	EVENT_CLOSED?: string; // '1' when event frozen (read-only)
}

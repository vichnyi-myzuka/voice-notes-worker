// Вхід у Google Calendar (офіційний віддалений MCP Google Workspace): звичайний OAuth 2.0 для веб-застосунку.
// На відміну від Сільпо, Google не дає динамічної реєстрації клієнта: client id і secret беруться з секретів воркера
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; клієнт у Google Cloud з позначкою «Use this client for an AI-powered agent»).
// Власник один раз відкриває /calendar/login; далі воркер сам оновлює access-токен через refresh_token.
// Токени живуть у сховищі Durable Object; у контейнер іде лише короткий access-токен (див. mcpConfig у payload.ts).

export const CALENDAR_MCP_URL = "https://calendarmcp.googleapis.com/mcp/v1";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Читання календарів і подій + створення, зміна й видалення подій (create_event, update_event, delete_event).
const SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"];
const KEY = "calendar";
const REFRESH_MARGIN_MS = 5 * 60_000; // оновлюємо токен, якщо він спливає раніше
const DEFAULT_TTL_S = 3600;

type Tokens = { access: string; refresh?: string; expiresAt: number };
type State = {
	pending?: { state: string; verifier: string; redirect: string };
	tokens?: Tokens;
};
export type GoogleClient = { id?: string; secret?: string };

type Storage = Pick<DurableObjectStorage, "get" | "put">;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class Calendar {
	constructor(
		private readonly storage: Storage,
		private readonly client: GoogleClient,
	) {}

	private load = async () => (await this.storage.get<State>(KEY)) ?? {};
	private save = (s: State) => this.storage.put(KEY, s);

	async connected(): Promise<boolean> {
		return !!(await this.load()).tokens;
	}

	// Адреса входу в Google: запам'ятовує PKCE і state. Без client id/secret вхід неможливий.
	async loginUrl(origin: string): Promise<string> {
		if (!this.client.id || !this.client.secret) throw new Error("calendar: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET не задані");
		const redirect = `${origin}/calendar/callback`;
		const verifier = random(48);
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		const s = await this.load();
		s.pending = { state: random(24), verifier, redirect };
		await this.save(s);
		const q = new URLSearchParams({
			response_type: "code",
			client_id: this.client.id,
			redirect_uri: redirect,
			scope: SCOPES.join(" "),
			state: s.pending.state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			access_type: "offline", // без цього Google не видає refresh_token
			prompt: "consent", // і щоб refresh_token прийшов і при повторному вході
		});
		return `${AUTH_URL}?${q}`;
	}

	// Обмінює код з повернення після входу на токени. false — state не збігся (чужий чи застарілий перехід).
	async callback(code: string, state: string): Promise<boolean> {
		const s = await this.load();
		if (!s.pending || s.pending.state !== state) return false;
		const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: s.pending.redirect, code_verifier: s.pending.verifier });
		await this.save({ tokens });
		return true;
	}

	// Дійсний access-токен (за потреби оновлює); undefined, якщо входу не було чи refresh не вдався (тоді потрібен новий вхід).
	async accessToken(): Promise<string | undefined> {
		const s = await this.load();
		if (!s.tokens) return undefined;
		if (s.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s.tokens.access;
		if (!s.tokens.refresh) return undefined;
		try {
			const fresh = await this.token({ grant_type: "refresh_token", refresh_token: s.tokens.refresh });
			// Google при оновленні не повертає новий refresh_token: лишається старий.
			await this.save({ ...s, tokens: { ...fresh, refresh: fresh.refresh ?? s.tokens.refresh } });
			return fresh.access;
		} catch (err) {
			console.error("calendar refresh failed:", err);
			return undefined;
		}
	}

	private async token(params: Record<string, string>): Promise<Tokens> {
		const form = new URLSearchParams({ ...params, client_id: this.client.id ?? "", client_secret: this.client.secret ?? "" });
		const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
		if (!res.ok) throw new Error(`calendar token ${res.status}`);
		const body = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number }>();
		if (!body.access_token) throw new Error("calendar token: no access_token");
		return { access: body.access_token, ...(body.refresh_token && { refresh: body.refresh_token }), expiresAt: Date.now() + (body.expires_in ?? DEFAULT_TTL_S) * 1000 };
	}
}

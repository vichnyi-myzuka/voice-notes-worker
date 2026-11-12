// Вхід в офіційний MCP Сільпо (https://mcp.silpo.ua/mcp): OAuth 2.1 з PKCE і динамічною реєстрацією клієнта.
// Власник один раз відкриває /silpo/login і входить у Сільпо; далі воркер сам оновлює access-токен через refresh_token.
// Усе живе у сховищі Durable Object; у контейнер іде лише короткий access-токен (див. mcpConfig у payload.ts).

export const SILPO_MCP_URL = "https://mcp.silpo.ua/mcp";
const ISSUER = "https://mcp.silpo.ua";
const KEY = "silpo";
const REFRESH_MARGIN_MS = 5 * 60_000; // оновлюємо токен, якщо він спливає раніше
const DEFAULT_TTL_S = 3600;

type Tokens = { access: string; refresh?: string; expiresAt: number };
type State = {
	client?: { id: string; secret?: string; redirect: string };
	pending?: { state: string; verifier: string };
	tokens?: Tokens;
};

type Storage = Pick<DurableObjectStorage, "get" | "put">;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class Silpo {
	constructor(private readonly storage: Storage) {}

	private load = async () => (await this.storage.get<State>(KEY)) ?? {};
	private save = (s: State) => this.storage.put(KEY, s);

	async connected(): Promise<boolean> {
		return !!(await this.load()).tokens;
	}

	// Адреса входу в Сільпо: реєструє клієнта (якщо ще немає або змінилась адреса воркера) і запам'ятовує PKCE та state.
	async loginUrl(origin: string): Promise<string> {
		const redirect = `${origin}/silpo/callback`;
		const s = await this.load();
		if (s.client?.redirect !== redirect) s.client = await this.register(redirect);
		const verifier = random(48);
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		s.pending = { state: random(24), verifier };
		await this.save(s);
		const q = new URLSearchParams({ response_type: "code", client_id: s.client.id, redirect_uri: redirect, state: s.pending.state, code_challenge: challenge, code_challenge_method: "S256" });
		return `${ISSUER}/authorize?${q}`;
	}

	// Обмінює код з повернення після входу на токени. false — state не збігся (чужий чи застарілий перехід).
	async callback(code: string, state: string): Promise<boolean> {
		const s = await this.load();
		if (!s.client || !s.pending || s.pending.state !== state) return false;
		const tokens = await this.token(s.client, { grant_type: "authorization_code", code, redirect_uri: s.client.redirect, code_verifier: s.pending.verifier });
		await this.save({ ...s, pending: undefined, tokens });
		return true;
	}

	// Дійсний access-токен (за потреби оновлює); undefined, якщо входу не було чи refresh не вдався (тоді потрібен новий вхід).
	async accessToken(): Promise<string | undefined> {
		const s = await this.load();
		if (!s.tokens) return undefined;
		if (s.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s.tokens.access;
		if (!s.client || !s.tokens.refresh) return undefined;
		try {
			const fresh = await this.token(s.client, { grant_type: "refresh_token", refresh_token: s.tokens.refresh });
			// Сервер міг не повернути новий refresh_token: тоді лишається старий.
			await this.save({ ...s, tokens: { ...fresh, refresh: fresh.refresh ?? s.tokens.refresh } });
			return fresh.access;
		} catch (err) {
			console.error("silpo refresh failed:", err);
			return undefined;
		}
	}

	private async register(redirect: string): Promise<NonNullable<State["client"]>> {
		const res = await fetch(`${ISSUER}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: "Agent", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
		});
		if (!res.ok) throw new Error(`silpo register ${res.status}`);
		const body = await res.json<{ client_id?: string; client_secret?: string }>();
		if (!body.client_id) throw new Error("silpo register: no client_id");
		return { id: body.client_id, ...(body.client_secret && { secret: body.client_secret }), redirect };
	}

	private async token(client: NonNullable<State["client"]>, params: Record<string, string>): Promise<Tokens> {
		const form = new URLSearchParams({ ...params, client_id: client.id, ...(client.secret && { client_secret: client.secret }) });
		const res = await fetch(`${ISSUER}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
		if (!res.ok) throw new Error(`silpo token ${res.status}`);
		const body = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number }>();
		if (!body.access_token) throw new Error("silpo token: no access_token");
		return { access: body.access_token, ...(body.refresh_token && { refresh: body.refresh_token }), expiresAt: Date.now() + (body.expires_in ?? DEFAULT_TTL_S) * 1000 };
	}
}

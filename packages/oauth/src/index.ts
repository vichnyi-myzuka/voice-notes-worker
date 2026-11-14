// Вхід через OAuth 2.0 (code + PKCE) для зовнішніх сервісів, токени яких воркер тримає в Durable Object.
// Власник один раз відкриває сторінку входу; далі воркер сам оновлює access-токен через refresh_token.
// Клієнт OAuth або заданий наперед (client id/secret із секретів воркера), або реєструється динамічно (`register`).

export type OAuthProvider = {
	name: string; // для повідомлень про помилки
	key: string; // ключ у сховищі Durable Object
	authUrl: string;
	tokenUrl: string;
	callbackPath: string; // куди сервіс повертає після входу, напр. /silpo/callback
	scope?: string;
	authParams?: Record<string, string>; // додаткові параметри адреси входу
	client?: { id?: string; secret?: string }; // клієнт, заданий наперед (без нього вхід неможливий)
	register?: { url: string; clientName: string }; // динамічна реєстрація клієнта (замість `client`)
};

export type OAuthToken = { access: string; expiresAt: number };

type Tokens = { access: string; refresh?: string; expiresAt: number };
type Client = { id: string; secret?: string; redirect: string };
type State = {
	client?: Client; // лише для динамічної реєстрації
	pending?: { state: string; verifier: string; redirect?: string };
	tokens?: Tokens;
};

type Storage = Pick<DurableObjectStorage, "get" | "put">;

const REFRESH_MARGIN_MS = 5 * 60_000; // оновлюємо токен, якщо він спливає раніше
const DEFAULT_TTL_S = 3600;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export class OAuthLogin {
	constructor(
		private readonly storage: Storage,
		private readonly provider: OAuthProvider,
	) {}

	private load = async () => (await this.storage.get<State>(this.provider.key)) ?? {};
	private save = (s: State) => this.storage.put(this.provider.key, s);

	// Вхід є й токен придатний: протермінований refresh-токен вважається відсутнім входом, щоб бот одразу дав посилання.
	async connected(): Promise<boolean> {
		return !!(await this.accessToken());
	}

	// Адреса входу: (за потреби реєструє клієнта і) запам'ятовує PKCE та state.
	async loginUrl(origin: string): Promise<string> {
		const p = this.provider;
		const redirect = `${origin}${p.callbackPath}`;
		const s = await this.load();
		let clientId: string;
		if (p.register) {
			if (s.client?.redirect !== redirect) s.client = await this.register(p.register, redirect);
			clientId = s.client.id;
		} else {
			if (!p.client?.id || !p.client.secret) throw new Error(`${p.name}: client id/secret не задані`);
			clientId = p.client.id;
		}
		const verifier = random(48);
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		s.pending = { state: random(24), verifier, redirect };
		await this.save(s);
		const q = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirect,
			...(p.scope && { scope: p.scope }),
			state: s.pending.state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			...p.authParams,
		});
		return `${p.authUrl}?${q}`;
	}

	// Обмінює код з повернення після входу на токени. false — state не збігся (чужий чи застарілий перехід).
	async callback(code: string, state: string): Promise<boolean> {
		const s = await this.load();
		if (!s.pending || s.pending.state !== state) return false;
		const redirect = s.pending.redirect ?? s.client?.redirect;
		if (!redirect) return false;
		const tokens = await this.token(s.client, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: s.pending.verifier });
		await this.save({ ...s, pending: undefined, tokens });
		return true;
	}

	// Дійсний access-токен із часом спливання (за потреби оновлює); undefined, якщо входу не було чи refresh не вдався (тоді потрібен новий вхід).
	async accessToken(): Promise<OAuthToken | undefined> {
		const s = await this.load();
		if (!s.tokens) return undefined;
		if (s.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return { access: s.tokens.access, expiresAt: s.tokens.expiresAt };
		if (!s.tokens.refresh || (this.provider.register && !s.client)) return undefined;
		try {
			const fresh = await this.token(s.client, { grant_type: "refresh_token", refresh_token: s.tokens.refresh });
			// Сервер міг не повернути новий refresh_token: тоді лишається старий.
			await this.save({ ...s, tokens: { ...fresh, refresh: fresh.refresh ?? s.tokens.refresh } });
			return { access: fresh.access, expiresAt: fresh.expiresAt };
		} catch (err) {
			console.error(`${this.provider.name} refresh failed:`, err);
			return undefined;
		}
	}

	private async register(reg: NonNullable<OAuthProvider["register"]>, redirect: string): Promise<Client> {
		const name = this.provider.name;
		const res = await fetch(reg.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: reg.clientName, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
		});
		if (!res.ok) throw new Error(`${name} register ${res.status}`);
		const body = await res.json<{ client_id?: string; client_secret?: string }>();
		if (!body.client_id) throw new Error(`${name} register: no client_id`);
		return { id: body.client_id, ...(body.client_secret && { secret: body.client_secret }), redirect };
	}

	private async token(dynamic: Client | undefined, params: Record<string, string>): Promise<Tokens> {
		const name = this.provider.name;
		const client = this.provider.register ? dynamic : this.provider.client;
		const form = new URLSearchParams({ ...params, client_id: client?.id ?? "", ...(client?.secret && { client_secret: client.secret }) });
		const res = await fetch(this.provider.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
		if (!res.ok) throw new Error(`${name} token ${res.status}`);
		const body = await res.json<{ access_token?: string; refresh_token?: string; expires_in?: number }>();
		if (!body.access_token) throw new Error(`${name} token: no access_token`);
		return { access: body.access_token, ...(body.refresh_token && { refresh: body.refresh_token }), expiresAt: Date.now() + (body.expires_in ?? DEFAULT_TTL_S) * 1000 };
	}
}

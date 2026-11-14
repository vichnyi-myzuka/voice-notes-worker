// Входи в сервіси власника для MCP-серверів у контейнері сесії (див. mcpConfig у payload.ts). Саму логіку OAuth дає @voice-notes/oauth.
// Власник один раз відкриває сторінку входу; токени живуть у сховищі Durable Object, у контейнер іде лише короткий access-токен.
import { OAuthLogin } from "@voice-notes/oauth";

export const SILPO_MCP_URL = "https://mcp.silpo.ua/mcp";
const SILPO_ISSUER = "https://mcp.silpo.ua";

// Офіційний MCP Сільпо: OAuth 2.1 з PKCE і динамічною реєстрацією клієнта (/silpo/login).
export const silpoLogin = (storage: ConstructorParameters<typeof OAuthLogin>[0]) =>
	new OAuthLogin(storage, {
		name: "silpo",
		key: "silpo",
		authUrl: `${SILPO_ISSUER}/authorize`,
		tokenUrl: `${SILPO_ISSUER}/token`,
		callbackPath: "/silpo/callback",
		register: { url: `${SILPO_ISSUER}/register`, clientName: "Agent" },
	});

export type GoogleClient = { id?: string; secret?: string };

// MCP-сервер nspady/google-calendar-mcp: звичайний OAuth 2.0 для веб-застосунку (/calendar/login).
// На відміну від Сільпо, Google не дає динамічної реєстрації: client id і secret беруться з секретів воркера
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; клієнт у Google Cloud з позначкою «Use this client for an AI-powered agent»).
export const calendarLogin = (storage: ConstructorParameters<typeof OAuthLogin>[0], client: GoogleClient) =>
	new OAuthLogin(storage, {
		name: "calendar",
		key: "calendar",
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		callbackPath: "/calendar/callback",
		// Те саме право, яке просить сам MCP-сервер (його перевірено з усіма інструментами: календарі, події, вільний час, кольори).
		scope: "https://www.googleapis.com/auth/calendar",
		authParams: { access_type: "offline", prompt: "consent" }, // без цього Google не видає refresh_token, а без consent — при повторному вході
		client,
	});

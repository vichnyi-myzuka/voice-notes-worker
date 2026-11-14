// MCP-сервіси власника, які можна підключити до сесії: фінанси (Sure), покупки (Сільпо), Google Calendar, акаунт Cloudflare.
// Єдиний реєстр: назва, як сервіс називається в чаті, чи вміє він змінювати дані, чи потребує входу OAuth. Решта шарів
// тримає свої дані за сервісом як `Record<McpName, …>`, тож новий сервіс без них не збереться (tsc покаже, чого бракує).
export const MCP_SERVICES = {
	sure: { emoji: "💰", title: "Sure", writes: true, oauth: false },
	silpo: { emoji: "🛒", title: "Сільпо", writes: false, oauth: true },
	calendar: { emoji: "📅", title: "Календар", writes: true, oauth: true },
	cloudflare: { emoji: "☁️", title: "Cloudflare", writes: false, oauth: true },
} as const;

export type McpName = keyof typeof MCP_SERVICES;
export const MCP_NAMES = Object.keys(MCP_SERVICES) as McpName[];

// Сервіси із входом OAuth на сторінці воркера (/<сервіс>/login): Sure натомість має токен у секретах воркера.
export type OAuthMcpName = { [K in McpName]: (typeof MCP_SERVICES)[K]["oauth"] extends true ? K : never }[McpName];
export const OAUTH_MCP_NAMES = MCP_NAMES.filter((name): name is OAuthMcpName => MCP_SERVICES[name].oauth);

// Прапорці «сервіс підключено до сесії» (у записі сесії й у запиті на старт).
export type McpFlags = Partial<Record<McpName, boolean>>;

// Як сервіс називається в чаті (кнопки, пост сесії).
export const MCP_LABELS = Object.fromEntries(MCP_NAMES.map((name) => [name, `${MCP_SERVICES[name].emoji} ${MCP_SERVICES[name].title}`])) as Record<McpName, string>;

// Сервіси, що вміють змінювати дані власника: їх підключення завжди підтверджується кнопкою, навіть коли роутер упевнений.
// Сільпо й Cloudflare лише читають, тому вмикаються одразу.
export const MCP_WRITES: readonly McpName[] = MCP_NAMES.filter((name) => MCP_SERVICES[name].writes);

// Відповідь на запит підключити MCP посеред сесії: connected — підключено, агент продовжує; declined — власник відмовив;
// login — потрібен вхід у сервіс (посилання дає чат); unavailable — сервіс не налаштований у воркері.
export type McpAnswer = "connected" | "declined" | "login" | "unavailable";

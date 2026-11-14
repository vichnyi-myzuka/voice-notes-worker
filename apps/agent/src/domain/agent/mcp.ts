// MCP-сервіси власника, які можна підключити до сесії: фінанси (Sure), покупки (Сільпо), Google Calendar, акаунт Cloudflare.
export const MCP_NAMES = ["sure", "silpo", "calendar", "cloudflare"] as const;
export type McpName = (typeof MCP_NAMES)[number];

// Як сервіс називається в чаті (кнопки, пост сесії).
export const MCP_LABELS: Record<McpName, string> = { sure: "💰 Sure", silpo: "🛒 Сільпо", calendar: "📅 Календар", cloudflare: "☁️ Cloudflare" };

// Сервіси, що вміють змінювати дані власника: їх підключення завжди підтверджується кнопкою, навіть коли роутер упевнений.
// Сільпо й Cloudflare лише читають, тому вмикаються одразу.
export const MCP_WRITES: readonly McpName[] = ["sure", "calendar"];

// Відповідь на запит підключити MCP посеред сесії: connected — підключено, агент продовжує; declined — власник відмовив;
// login — потрібен вхід у сервіс (посилання дає чат); unavailable — сервіс не налаштований у воркері.
export type McpAnswer = "connected" | "declined" | "login" | "unavailable";

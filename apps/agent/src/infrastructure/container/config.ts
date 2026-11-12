import type { Env } from "../../env";

// Контейнер лишається живим, поки з ним працюють; потім засинає (ліміти й запобіжники — окремий тікет).
export const DEFAULT_INACTIVITY_MS = 60 * 60 * 1000;
export const READY_ATTEMPTS = 150;
// Потік подій (SSE) тримає Durable Object, а з ним і контейнер, активним: забута вкладка не давала б йому заснути. Тому потік
// живе не довше цього часу; жива вкладка перепідключиться сама.
export const STREAM_MAX_MS = 10 * 60 * 1000;
// Знімок диска робимо не частіше й лише коли була активність; поки контейнер працює, alarm перевіряє це.
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

// Поки сесія працює чи за нею стежать, alarm спрацьовує частіше: підсумок у чаті й ліміти витрат.
export const WATCH_INTERVAL_MS = 15 * 1000;
// Сесія, що не повернулась у вільний стан за цей час, перестає відстежуватись (контейнер міг загинути).
export const WATCH_MAX_MS = 2 * 60 * 60 * 1000;
// Запобіжники за замовчуванням: вартість однієї сесії (USD) і токени (вхід + вихід + reasoning, без кешу).
export const DEFAULT_MAX_COST_USD = 5;
export const DEFAULT_MAX_TOKENS = 3_000_000;
export const WORKING = "⏳ Працює";
// Прийняті завдання (begin/resume) виконує alarm: холодний старт і клон довші за життя запиту вебхука. Збій повторюється,
// потім показується в пості.
export const JOB_ATTEMPTS = 6;
export const JOB_RETRY_MS = 15 * 1000;
export const PROGRESS_INTERVAL_MS = 4000; // не частіше: ліміти Telegram на редагування одного повідомлення
export const HEADER_DEPLOYED_MAX = 150; // шапка згорнутого поста після успішного деплою
export const HEADER_FINAL_MAX = 400; // шапка поста разом із підсумком (підсумок до SUMMARY_MAX) має вміститись у 4096
export const SUMMARY_MAX = 3000; // підсумок у чат: решта обрізається (ліміт повідомлення Telegram — 4096)

// Тривалості й ліміти з необов'язкових змінних воркера (для коротких перевірок); некоректні значення ігноруються.
export function positiveNumber(value: string | undefined): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function positiveInt(value: string | undefined): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export const inactivityMs = (env: Env): number => positiveInt(env.AGENT_INACTIVITY_MS) ?? DEFAULT_INACTIVITY_MS;
export const snapshotIntervalMs = (env: Env): number => positiveInt(env.AGENT_SNAPSHOT_INTERVAL_MS) ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
export const progressMs = (env: Env): number => positiveInt(env.AGENT_PROGRESS_MS) ?? PROGRESS_INTERVAL_MS;
export const maxCostUsd = (env: Env): number => positiveNumber(env.AGENT_MAX_COST_USD) ?? DEFAULT_MAX_COST_USD;
export const maxTokens = (env: Env): number => positiveInt(env.AGENT_MAX_TOKENS) ?? DEFAULT_MAX_TOKENS;

export function publishEnv(env: Env): Record<string, string> {
	const vars = { R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, R2_ENDPOINT: env.R2_ENDPOINT, SITES_BASE_URL: env.SITES_BASE_URL };
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

export function containerEnv(env: Env): Record<string, string> {
	const vars: Record<string, string | undefined> = {
		OPENCODE_PASSWORD: env.OPENCODE_PASSWORD,
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		GITHUB_TOKEN: env.GITHUB_TOKEN,
		CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
		// Публікація сайтів (команда publish): ключ R2 лише на бакет сайтів і адреса сайтів
		R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
		R2_ENDPOINT: env.R2_ENDPOINT,
		SITES_BASE_URL: env.SITES_BASE_URL,
		// Публічні сайти: окремий ключ лише на публічний бакет (endpoint спільний)
		PUBLIC_R2_ACCESS_KEY_ID: env.PUBLIC_R2_ACCESS_KEY_ID,
		PUBLIC_R2_SECRET_ACCESS_KEY: env.PUBLIC_R2_SECRET_ACCESS_KEY,
		PUBLIC_SITES_BASE_URL: env.PUBLIC_SITES_BASE_URL,
	};
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

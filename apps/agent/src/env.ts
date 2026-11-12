import type { AgentSession } from "./infrastructure/container";

// Прив'язки й секрети воркера агента (див. wrangler.toml і README).
export interface Env {
	AGENT_SESSION: DurableObjectNamespace<AgentSession>;
	// Cloudflare Access: team domain (`<team>.cloudflareaccess.com`) і AUD застосунку
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	// Пароль OpenCode V2 (basic auth, користувач `opencode`) усередині контейнера: воркер підставляє його сам
	OPENCODE_PASSWORD: string;
	// Ключі моделей і доступ до git, що передаються в контейнер (усе необов'язкове)
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string; // також використовує мала модель, що описує дію агента в пості (gpt-6-luna)
	GITHUB_TOKEN?: string;
	// Підписка Claude замість API-ключа: токен з `claude setup-token`; тоді сесії йдуть через провайдер Claude Agent
	CLAUDE_CODE_OAUTH_TOKEN?: string;
	// Модель Claude Agent (opus, sonnet, haiku, fable); за замовчуванням sonnet
	CLAUDE_MODEL?: string;
	// Тривалості в мс (за замовчуванням 1 година простою і 5 хвилин між знімками); коротші значення — для перевірки на Cloudflare
	AGENT_INACTIVITY_MS?: string;
	AGENT_SNAPSHOT_INTERVAL_MS?: string;
	// Запобіжники сесії: вартість у USD (за замовчуванням 5) і токени без кешу (за замовчуванням 3 млн); понад ліміт сесію зупиняє alarm
	AGENT_MAX_COST_USD?: string;
	AGENT_MAX_TOKENS?: string;
	AGENT_PROGRESS_MS?: string; // мінімальний інтервал оновлення поста з прогресом (мс; типово 4000)
	// Чат з агентом у Telegram (окремий бот): токен, секрет вебхука, єдиний дозволений користувач. Whisper — через Workers AI.
	BOT_TOKEN?: string;
	TG_WEBHOOK_SECRET?: string;
	TG_OWNER_ID?: string;
	CHAT_ID?: string; // канал, у який публікуєш задачі (бот адмін): працює так само, як канал бота нотаток
	AI: Ai;
	// Публікація статичних сайтів (команда `publish` у контейнері): ключ R2 лише на бакет `agent-sites`, endpoint акаунта
	// (`https://<account>.r2.cloudflarestorage.com`) і адреса воркера сайтів. Усе йде в контейнер.
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_ENDPOINT?: string;
	SITES_BASE_URL?: string;
	// Публічні сайти (`publish --public`): окремий токен R2 лише на публічний бакет і адреса публічного хоста
	PUBLIC_R2_ACCESS_KEY_ID?: string;
	PUBLIC_R2_SECRET_ACCESS_KEY?: string;
	PUBLIC_SITES_BASE_URL?: string;
	// JSON-масив [{repo: "owner/name", about: "як власник його називає"}]: з нього бот вибирає репозиторій за вільною фразою (не секрет, див. wrangler.toml)
	AGENT_REPOS?: string;
	LOCAL_DEV?: string; // лише `npm run dev`: вимикає перевірку Access
}

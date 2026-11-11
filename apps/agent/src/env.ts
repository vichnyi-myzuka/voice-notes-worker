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
	OPENAI_API_KEY?: string;
	GITHUB_TOKEN?: string;
	// Підписка Claude замість API-ключа: токен з `claude setup-token`; тоді сесії йдуть через провайдер Claude Agent
	CLAUDE_CODE_OAUTH_TOKEN?: string;
	// Модель Claude Agent (opus, sonnet, haiku, fable); за замовчуванням sonnet
	CLAUDE_MODEL?: string;
	// Тривалості в мс (за замовчуванням 1 година простою і 5 хвилин між знімками); коротші значення — для перевірки на Cloudflare
	AGENT_INACTIVITY_MS?: string;
	AGENT_SNAPSHOT_INTERVAL_MS?: string;
	LOCAL_DEV?: string; // лише `npm run dev`: вимикає перевірку Access
}

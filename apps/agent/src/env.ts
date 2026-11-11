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
	LOCAL_DEV?: string; // лише `npm run dev`: вимикає перевірку Access
}

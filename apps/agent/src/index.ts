// Розгортається через GitHub Actions після мержу в main зі схваленням (environment production-agent, див. README, «CI/CD»).
import type { Env } from "./env";
import { durableAgent } from "./infrastructure/container";
import { workersLlm } from "@voice-notes/core";
import { durableSchedules } from "./infrastructure/scheduler";
import { AGENT_API_PATH, handleAgentApi, handleFetch } from "./interface/http";
import { GITHUB_PATH, handleGithub } from "./interface/github";
import { TELEGRAM_PATH, handleTelegram, parseRepos } from "./interface/telegram";

export { AgentSession } from "./infrastructure/container";
export { Scheduler } from "./infrastructure/scheduler";
export type { Env } from "./env";

export default {
	fetch: (req, env, ctx) => {
		const url = new URL(req.url);
		const agent = durableAgent(env.AGENT_SESSION, url.origin);
		// Вебхуки Telegram і GitHub стоять повз Access (див. docs/adr/0003-webhooks-bypass-access.md), решта — за Access.
		if (url.pathname === TELEGRAM_PATH) return handleTelegram(req, env, { agent, llm: workersLlm(env), repos: parseRepos(env.AGENT_REPOS), defer: (w) => ctx.waitUntil(w), syncCommands: true, schedules: durableSchedules(env.SCHEDULER) });
		if (url.pathname === GITHUB_PATH) return handleGithub(req, env, { agent, defer: (w) => ctx.waitUntil(w) });
		// Агент із контейнера: за Access (Service Token) і секретом сесії (ADR 0003).
		if (url.pathname === AGENT_API_PATH || url.pathname.startsWith(`${AGENT_API_PATH}/`)) return handleAgentApi(req, env, durableSchedules(env.SCHEDULER));
		return handleFetch(req, env, agent, durableSchedules(env.SCHEDULER));
	},
} satisfies ExportedHandler<Env>;

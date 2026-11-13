// Розгортається через GitHub Actions після мержу в main зі схваленням (environment production-agent, див. README, «CI/CD»).
import type { Env } from "./env";
import { durableAgent } from "./infrastructure/container";
import { workersLlm } from "@voice-notes/core";
import { handleFetch } from "./interface/http";
import { GITHUB_PATH, handleGithub } from "./interface/github";
import { TELEGRAM_PATH, handleTelegram, parseRepos } from "./interface/telegram";

export { AgentSession } from "./infrastructure/container";
export type { Env } from "./env";

export default {
	fetch: (req, env, ctx) => {
		const url = new URL(req.url);
		const agent = durableAgent(env.AGENT_SESSION, url.origin);
		// Вебхуки Telegram і GitHub стоять повз Access (див. README), решта — за Access.
		if (url.pathname === TELEGRAM_PATH) return handleTelegram(req, env, { agent, llm: workersLlm({ AI: env.AI, OPENAI_KEY: env.OPENAI_API_KEY }), repos: parseRepos(env.AGENT_REPOS), defer: (w) => ctx.waitUntil(w), syncCommands: true });
		if (url.pathname === GITHUB_PATH) return handleGithub(req, env, { agent, defer: (w) => ctx.waitUntil(w) });
		return handleFetch(req, env, agent);
	},
} satisfies ExportedHandler<Env>;

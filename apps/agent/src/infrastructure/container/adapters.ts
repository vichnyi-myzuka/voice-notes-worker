import type { LimitProbe, Notices, Scheduler } from "../../domain/agent";
import type { ChatEnv, ContainerEnv } from "../../env";
import { sendChat } from "../chat";
import { fetchQuota, isBlocked, resetTime } from "../quota";
import type { Computer } from "./computer";
import type { Posts } from "../../application/progress";

// Адаптери портів ядра агента (domain/agent/ports.ts) до Durable Object, чату й підписки Claude.

export const durableScheduler = (ctx: DurableObjectState, computer: Computer): Scheduler => ({
	now: () => ctx.storage.setAlarm(Date.now()),
	noLater: (at) => computer.alarmNoLater(at),
	background: (work) => ctx.waitUntil(work),
});

export const chatNotices = (env: ChatEnv, posts: Posts): Notices => ({
	enabled: !!env.BOT_TOKEN,
	show: (id, target, text, final) => posts.show(id, target, text, final),
	send: async (id, target, text, kind) => {
		if (!env.BOT_TOKEN) return;
		await sendChat({ BOT_TOKEN: env.BOT_TOKEN }, target.chatId, text, { id, url: target.url }, kind, undefined, undefined, target.threadId);
	},
});

export const claudeLimits = (env: ContainerEnv): LimitProbe => ({
	configured: !!env.CLAUDE_CODE_OAUTH_TOKEN,
	async read() {
		if (!env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
		const quota = await fetchQuota(env.CLAUDE_CODE_OAUTH_TOKEN).catch((err) => (console.error("quota check failed:", err), undefined));
		return quota && { blocked: isBlocked(quota), resetAt: resetTime(quota) };
	},
});

import type { Container, LimitProbe, Notices, PullRequests, Scheduler } from "../../domain/agent";
import type { ChatEnv, ContainerEnv, GithubEnv } from "../../env";
import { sendChat, sendMcpQuestion } from "../chat";
import { openPullNumber } from "../github";
import { fetchQuota, isBlocked, resetTime } from "../quota";
import type { Computer } from "./computer";
import type { Posts } from "../../application/progress";
import { sendImages } from "./progress";

// Адаптери портів ядра агента (domain/agent/ports.ts) до Durable Object, чату й підписки Claude.

export const durableScheduler = (ctx: DurableObjectState, computer: Computer): Scheduler => ({
	now: () => ctx.storage.setAlarm(Date.now()),
	noLater: (at) => computer.alarmNoLater(at),
	background: (work) => ctx.waitUntil(work),
});

export const chatNotices = (env: ChatEnv, posts: Posts, readImage: (path: string) => Promise<Uint8Array | undefined>): Notices => ({
	enabled: !!env.BOT_TOKEN,
	show: (id, target, text, final) => posts.show(id, target, text, final),
	send: async (id, target, text, kind) => {
		if (!env.BOT_TOKEN) return;
		await sendChat({ BOT_TOKEN: env.BOT_TOKEN }, target.chatId, text, { id, url: target.url }, kind, undefined, undefined, target.threadId);
	},
	images: async (target, images) => {
		if (!env.BOT_TOKEN) return;
		await sendImages({ BOT_TOKEN: env.BOT_TOKEN }, target.chatId, images, readImage, target.threadId);
	},
	askMcp: async (id, target, name, text) => {
		if (!env.BOT_TOKEN) return;
		await sendMcpQuestion({ BOT_TOKEN: env.BOT_TOKEN }, target.chatId, target.threadId, id, name, text);
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

export const containerOf = (computer: Computer): Container => ({
	get running() {
		return computer.running;
	},
	readImage: (path) => computer.readImage(path),
});

export const githubPulls = (env: GithubEnv): PullRequests => ({
	configured: !!env.GITHUB_TOKEN,
	openNumber: (repo, branch) => openPullNumber(env.GITHUB_TOKEN!, repo, branch),
});

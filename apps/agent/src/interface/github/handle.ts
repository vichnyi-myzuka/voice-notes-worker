import { safeEqual, tg, type BotEnv } from "@voice-notes/core";
import type { Deploys, Sessions } from "../../domain/agent";
import type { Env } from "../../env";
import { commitPulls, deleteBranch } from "../../infrastructure/github";
import { callback, removeMessage, removeOriginal } from "../../infrastructure/chat";
import { reviewButtons } from "./review";

export const GITHUB_PATH = "/github";

export type GithubDeps = { agent: Sessions & Deploys; defer: (work: Promise<unknown>) => void };

type Payload = {
	action?: string;
	repository?: { full_name: string; default_branch: string };
	workflow_job?: { run_id: number; head_sha?: string; name: string; workflow_name?: string; head_branch?: string; html_url: string };
	workflow_run?: { id: number; name: string; head_branch: string; head_sha?: string; html_url: string; conclusion?: string | null };
};

const REPO = /^[\w.-]+\/[\w.-]+$/;

// HMAC-SHA256 тіла за секретом вебхука, як у заголовку `X-Hub-Signature-256: sha256=<hex>`.
async function validSignature(body: string, header: string, secret: string): Promise<boolean> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return safeEqual(header, `sha256=${hex}`);
}

// Вебхук GitHub (повз Access, як і Telegram: захищає підпис). Дві події:
//  • workflow_job waiting (job чекає схвалення environment): надсилаємо в чат запит на схвалення деплою з кнопками (див. review.ts);
//  • workflow_run completed (deploy на головній гілці): результат деплою й PR; після успіху ще й прибирання сесії PR бота
//    (сесія, worktree, локальна й віддалена гілка, пост у чаті).
// GitHub отримує 200 одразу, робота йде у фоні.
export async function handleGithub(req: Request, env: Env, deps: GithubDeps): Promise<Response> {
	if (req.method !== "POST" || !env.GITHUB_WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });
	const body = await req.text();
	if (!(await validSignature(body, req.headers.get("x-hub-signature-256") ?? "", env.GITHUB_WEBHOOK_SECRET))) return new Response("unauthorized", { status: 401 });
	if (!env.BOT_TOKEN) return new Response("bot is not configured", { status: 503 });
	const bot = { BOT_TOKEN: env.BOT_TOKEN };
	let payload: Payload;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response("bad json", { status: 400 });
	}
	const repo = payload.repository?.full_name;
	if (!repo || !REPO.test(repo)) return new Response("ok");
	const event = req.headers.get("x-github-event");
	if (event === "workflow_job") deps.defer(onReviewRequested(bot, env, deps, repo, payload).catch((err) => console.error("github review failed:", err)));
	else if (event === "workflow_run") deps.defer(onDeployFinished(bot, env, deps, repo, payload).catch((err) => console.error("github deploy result failed:", err)));
	return new Response("ok");
}

// Результат деплою (workflow `deploy` після мержу в головну гілку) і PR, який його запустив.
const DEPLOY_WORKFLOW = "deploy";
const RESULT: Record<string, string> = { success: "✅ Деплой успішний", failure: "❌ Деплой не вдався", timed_out: "❌ Деплой не вдався (час вийшов)", cancelled: "⏹ Деплой скасовано" };

async function onDeployFinished(bot: BotEnv, env: Env, { agent }: GithubDeps, repo: string, p: Payload): Promise<void> {
	const run = p.workflow_run;
	const chat = env.TG_OWNER_ID ?? env.CHAT_ID;
	const title = run?.conclusion ? RESULT[run.conclusion] : undefined;
	if (p.action !== "completed" || !run || !chat || !title || run.name !== DEPLOY_WORKFLOW || run.head_branch !== p.repository?.default_branch) return;
	const pulls = env.GITHUB_TOKEN && run.head_sha ? await commitPulls(env.GITHUB_TOKEN, repo, run.head_sha).catch((err) => (console.error("commit pulls failed:", err), [])) : [];
	// PR бота (гілка agent/* цього ж репозиторію): результат показуємо в пості його сесії. Успішний деплой ще й прибирає сесію, worktree
	// і гілки, а пост лишається з відміткою (видалити його можна кнопкою). Невдалий деплой сесію лишає, щоб можна було дописати уточнення.
	let shown = false;
	let cleaned = 0;
	for (const pr of pulls) {
		if (pr.repo !== repo || !pr.branch.startsWith("agent/")) continue;
		const inPost = await agent.setDeploy(repo, pr.branch.slice("agent/".length), { text: `${title}\n${run.html_url}`, done: run.conclusion === "success", stage: run.conclusion === "success" ? "deployed" : "failed" }).catch((err) => (console.error("show deploy in post failed:", err), false));
		shown ||= inPost;
		if (run.conclusion === "success") cleaned += (await cleanup(bot, env, agent, repo, pr.branch, inPost).catch((err) => (console.error("cleanup failed:", err), false))) ? 1 : 0;
	}
	if (shown) return;
	const text = [title, repo, ...pulls.map((pr) => `PR #${pr.number}: ${pr.title}\n${pr.url}`), run.html_url, cleaned && "🧹 Сесію, worktree і гілку прибрано."].filter(Boolean).join("\n");
	const reply_markup = { inline_keyboard: [[{ text: "🗑 Видалити", callback_data: callback.dismiss }]] };
	// Якщо цей запуск чекав схвалення в окремому пості, результат дописуємо в нього (а не шлемо новий).
	const asked = await agent.takeRef(refKey(repo, run.id)).catch(() => undefined);
	if (asked && (await tg(bot, "editMessageText", { chat_id: asked.chatId, message_id: asked.messageId, text: `${asked.text}\n\n${text}`, reply_markup, link_preview_options: { is_disabled: true } }).then(() => true, (err) => (console.error("edit approval post failed:", err), false)))) return;
	await tg(bot, "sendMessage", { chat_id: chat, text, reply_markup, link_preview_options: { is_disabled: true } });
}

// Прибирає сесію гілки (як /delete) і віддалену гілку; пост у чаті видаляє, лише якщо він не показує результату (keepPost). true, якщо сесію знайдено.
async function cleanup(bot: BotEnv, env: Env, agent: Sessions & Deploys, repo: string, branch: string, keepPost: boolean): Promise<boolean> {
	const removed = await agent.removeByBranch(repo, branch.slice("agent/".length));
	if (env.GITHUB_TOKEN) await deleteBranch(env.GITHUB_TOKEN, repo, branch).catch((err) => console.error("delete remote branch failed:", err));
	if (!removed) return false;
	if (removed.chatId && removed.postId && !keepPost) await removeMessage(bot, removed.chatId, removed.postId);
	if (removed.chatId) await removeOriginal(bot, removed.chatId, removed.id);
	return true;
}

// Ключ посту зі схваленням: репозиторій і id запуску (однаковий у workflow_job і workflow_run).
const refKey = (repo: string, runId: number) => `deploy:${repo}:${runId}`;

// Job чекає схвалення environment (workflow_job зі статусом waiting): пост із кнопками.
async function onReviewRequested(bot: BotEnv, env: Env, { agent }: GithubDeps, repo: string, p: Payload): Promise<void> {
	const job = p.workflow_job;
	const chat = env.TG_OWNER_ID ?? env.CHAT_ID;
	if (p.action !== "waiting" || !job || !chat) return;
	const text = `🚀 Деплой чекає схвалення\n${repo} · ${job.name}\n${job.workflow_name ?? "workflow"}${job.head_branch ? ` (${job.head_branch})` : ""}\n${job.html_url}`;
	// Деплой PR бота: запит на схвалення показуємо в пості його сесії, а не окремим повідомленням.
	const pulls = env.GITHUB_TOKEN && job.head_sha ? await commitPulls(env.GITHUB_TOKEN, repo, job.head_sha).catch((err) => (console.error("commit pulls failed:", err), [])) : [];
	for (const pr of pulls) {
		if (pr.repo !== repo || !pr.branch.startsWith("agent/")) continue;
		if (await agent.setDeploy(repo, pr.branch.slice("agent/".length), { text: `🚀 Деплой чекає схвалення\n${job.html_url}`, repo, runId: job.run_id, stage: "approval" }).catch(() => false)) return;
	}
	const sent = await tg(bot, "sendMessage", { chat_id: chat, text, reply_markup: reviewButtons(repo, job.run_id), link_preview_options: { is_disabled: true } });
	await agent.saveRef(refKey(repo, job.run_id), { chatId: chat, messageId: sent.message_id, text }).catch((err) => console.error("save approval post failed:", err));
}

import { tgSendMessage, type BotEnv, type TgMessage } from "@voice-notes/core";
import type { Agent } from "../../domain/agent";
import type { Env } from "../../env";
import { KEYS, removeMessage, removeOriginal, sayTemporarily, type SessionKey } from "../../infrastructure/chat";
// Єдиний дозволений імпорт між interface-модулями: ADR 0004.
// oxlint-disable-next-line no-restricted-imports
import { mergeSession } from "../github/review";
import { reviewDeployments } from "../../infrastructure/github";
import { RETRY_TEXT } from "./buttons";
import { parseRepos } from "./repo";

// Клавіша внизу теми (режим THREAD_UI=messages): діє на сесію цієї теми, відповідь — коротке повідомлення, що саме зникає.
// Саме повідомлення з клавіші прибираємо. Дії ті самі, що в кнопок під постом (buttons.ts).
export async function handleKey(bot: BotEnv, env: Env, msg: TgMessage, key: SessionKey, deps: { agent: Agent; sleep?: (ms: number) => Promise<void> }): Promise<void> {
	const { agent, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = deps;
	const chat = msg.chat.id;
	const threadId = msg.message_thread_id!;
	const cleanups: Promise<unknown>[] = [];
	const say = (text: string) => sayTemporarily(bot, chat, text, sleep, cleanups, threadId);
	const id = await agent.byThread(chat, threadId);
	if (!id || !(await agent.link(id))) {
		await tgSendMessage(bot, chat, `⚠️ ${KEYS[key]}: у цій темі немає сесії.`, threadId).catch(() => {});
		return;
	}
	if (key === "del") {
		await agent.remove(id);
		await removeOriginal(bot, chat, id);
		return; // тему разом із повідомленнями прибрано
	}
	const working = (await agent.report(id)).status === "working";
	if (key === "stop") {
		if (!working) await say("Нічого зупиняти.");
		else (await agent.abort(id), await say("⏹ Зупинено."));
	} else if (key === "retry") {
		if (working) await say("Агент уже працює.");
		else (await agent.resume(id, RETRY_TEXT, { chatId: chat, url: agent.url(id), threadId }), await say("🔄 Повторюю."));
	} else if (key === "approve" || key === "reject") {
		await review(env, agent, id, key === "approve", say);
	} else {
		await mergeSession(bot, env, agent, id, { chatId: chat, threadId, answer: say }, (repo) => parseRepos(env.AGENT_REPOS).find((r) => r.repo === repo)?.site);
	}
	await removeMessage(bot, chat, msg.message_id);
	await Promise.all(cleanups);
}

// «✅ Схвалити» / «❌ Відхилити»: деплой цієї сесії, що чекає схвалення (GitHub pending_deployments); пост сесії показує результат.
async function review(env: Env, agent: Agent, id: string, approve: boolean, say: (text: string) => Promise<unknown>): Promise<void> {
	if (!env.GITHUB_APPROVE_TOKEN) return void (await say("Не налаштовано GITHUB_APPROVE_TOKEN."));
	const pending = await agent.pendingReview(id);
	if (!pending) return void (await say("Немає деплою, що чекає схвалення."));
	let done: number;
	try {
		done = await reviewDeployments(env.GITHUB_APPROVE_TOKEN, pending.repo, pending.runId, approve);
	} catch (err) {
		console.error("review failed:", err);
		return void (await say(`Не вдалося звернутись до GitHub: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)));
	}
	const line = done === 0 ? "ℹ️ Деплой уже оброблено (або немає права)" : approve ? "✅ Деплой схвалено, виконується" : "❌ Деплой відхилено";
	await agent.setDeployByPost(pending.postId, { text: line, ...(done !== 0 && { stage: approve ? "deploying" : "failed" }) }).catch(() => false);
	await say(done === 0 ? "ℹ️ Уже оброблено" : approve ? "✅ Схвалено" : "❌ Відхилено");
}

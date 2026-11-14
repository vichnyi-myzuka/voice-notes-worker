import { tgSendMessage, type BotEnv, type TgMessage } from "@voice-notes/core";
import type { Agent } from "../../domain/agent";
import type { Env } from "../../env";
import { KEYS, removeMessage, removeOriginal, sayTemporarily, type SessionKey } from "../../infrastructure/chat";
// Єдиний дозволений імпорт між interface-модулями: ADR 0004.
// oxlint-disable-next-line no-restricted-imports
import { mergeSession } from "../github/review";
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
	} else {
		await mergeSession(bot, env, agent, id, { chatId: chat, threadId, answer: say }, (repo) => parseRepos(env.AGENT_REPOS).find((r) => r.repo === repo)?.site);
	}
	await removeMessage(bot, chat, msg.message_id);
	await Promise.all(cleanups);
}

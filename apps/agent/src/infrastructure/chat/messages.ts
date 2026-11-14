import { tg, type BotEnv } from "@voice-notes/core";

// Відповіді на команди (/status, /quota…) зникають з чату самі. Чекаємо в waitUntil, якому Cloudflare дає ~30 с після відповіді
// вебхука, тому трохи менше.
export const EPHEMERAL_MS = 25_000;
export const EPHEMERAL_MARK = "💨"; // позначка, що повідомлення зникне саме

export const removeMessage = (env: BotEnv, chat: number, messageId: number) =>
	tg(env, "deleteMessage", { chat_id: chat, message_id: messageId }).catch((err) => console.error("delete message failed:", err));

// Надсилає службову відповідь і видаляє її через EPHEMERAL_MS, щоб вона не лишалась в історії чату.
// Саме видалення повертається окремо (cleanups), щоб команду можна було прибрати одразу, не чекаючи.
export async function sayTemporarily(env: BotEnv, chat: number, text: string, sleep: (ms: number) => Promise<void>, cleanups: Promise<unknown>[], threadId?: number): Promise<void> {
	const sent = await tg(env, "sendMessage", { chat_id: chat, ...(threadId && { message_thread_id: threadId }), text: `${text} ${EPHEMERAL_MARK}` });
	cleanups.push(sleep(EPHEMERAL_MS).then(() => removeMessage(env, chat, sent.message_id)));
}

// Тема сесії створюється разом із нею (name — назва теми); undefined, якщо чат не підтримує теми (тоді все йде в сам чат).
export const createTopic = (env: BotEnv, chat: number, name: string): Promise<number | undefined> =>
	tg(env, "createForumTopic", { chat_id: chat, name: name.slice(0, 128) }).then(
		(topic) => topic.message_thread_id,
		(err) => (console.error("create topic failed:", err), undefined),
	);

// Перейменовує тему (напрям розмови змінився); збій не критичний.
export const renameTopic = (env: BotEnv, chat: number, threadId: number, name: string) =>
	tg(env, "editForumTopic", { chat_id: chat, message_thread_id: threadId, name: name.slice(0, 128) }).then(
		() => true,
		(err) => (console.error("rename topic failed:", err), false),
	);

// Емодзі теми за станом сесії. Telegram дозволяє лише іконки зі свого набору (getForumTopicIconStickers), тому для кожного
// стану є запасні варіанти: береться перший, що є в наборі.
// Стани деплою PR сесії: approval — чекає схвалення, deploying — змерджено/виконується, deployed — успіх, deployFailed — збій чи відхилення.
export type TopicState = "working" | "question" | "done" | "failed" | "approval" | "deploying" | "deployed" | "deployFailed";
const TOPIC_EMOJI: Record<TopicState, string[]> = {
	working: ["⚡", "🔥"],
	question: ["❓", "❗"],
	done: ["✅", "👍"],
	failed: ["❗", "❌"],
	approval: ["👀", "🙏", "❓"],
	deploying: ["🚀", "🔥", "⚡"],
	deployed: ["🎉", "🏆", "✅"],
	deployFailed: ["❌", "❗"],
};
let iconIds: Promise<Map<string, string>> | undefined;
const lastIcon = new Map<string, TopicState>(); // щоб не слати однаковий стан двічі

// Для тестів: забуває набір іконок і останній стан тем.
export function resetTopicIcons(): void {
	iconIds = undefined;
	lastIcon.clear();
}

// Ставить темі іконку стану; збій (немає прав, чат без тем, емодзі немає в наборі) не критичний.
export async function setTopicIcon(env: BotEnv, chat: number, threadId: number, state: TopicState): Promise<void> {
	const key = `${chat}:${threadId}`;
	if (lastIcon.get(key) === state) return;
	try {
		iconIds ??= tg(env, "getForumTopicIconStickers", {}).then((list) => new Map(list.flatMap((s) => (s.emoji && s.custom_emoji_id ? [[s.emoji.replace(/️/g, ""), s.custom_emoji_id] as const] : []))));
		const ids = await iconIds.catch((err) => ((iconIds = undefined), Promise.reject(err)));
		const id = TOPIC_EMOJI[state].map((e) => ids.get(e)).find(Boolean);
		if (!id) return;
		await tg(env, "editForumTopic", { chat_id: chat, message_thread_id: threadId, icon_custom_emoji_id: id });
		if (lastIcon.size > 500) lastIcon.clear();
		lastIcon.set(key, state);
	} catch (err) {
		console.error("topic icon failed:", err);
	}
}

// Видаляє тему разом з усіма повідомленнями в ній.
export const removeTopic = (env: BotEnv, chat: number, threadId: number) =>
	tg(env, "deleteForumTopic", { chat_id: chat, message_thread_id: threadId }).catch((err) => console.error("delete topic failed:", err));

// Оригінал, з якого почалась сесія (id сесії = tg-<чат>-<повідомлення>). У каналі його прибрано одразу, у приваті він лишається
// до видалення сесії; тут прибираємо лише приватний чат (id > 0), у каналі нічого не лишилось.
export function removeOriginal(env: BotEnv, chat: number, sessionId: string): Promise<unknown> {
	const [, origChat, origId] = /^tg-(-?\d+)-(\d+)$/.exec(sessionId) ?? [];
	if (!origId || Number(origChat) !== chat || chat < 0) return Promise.resolve();
	return removeMessage(env, chat, Number(origId));
}

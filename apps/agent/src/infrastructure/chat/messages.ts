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

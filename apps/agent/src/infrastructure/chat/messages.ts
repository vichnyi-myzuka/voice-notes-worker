import { tg, type BotEnv } from "@voice-notes/core";

// Відповіді на команди (/status, /quota…) зникають з чату самі. Чекаємо в waitUntil, якому Cloudflare дає ~30 с після відповіді
// вебхука, тому трохи менше.
export const EPHEMERAL_MS = 25_000;
export const EPHEMERAL_MARK = "💨"; // позначка, що повідомлення зникне саме

export const removeMessage = (env: BotEnv, chat: number, messageId: number) =>
	tg(env, "deleteMessage", { chat_id: chat, message_id: messageId }).catch((err) => console.error("delete message failed:", err));

// Надсилає службову відповідь і видаляє її через EPHEMERAL_MS, щоб вона не лишалась в історії чату.
// Саме видалення повертається окремо (cleanups), щоб команду можна було прибрати одразу, не чекаючи.
export async function sayTemporarily(env: BotEnv, chat: number, text: string, sleep: (ms: number) => Promise<void>, cleanups: Promise<unknown>[]): Promise<void> {
	const sent = await tg(env, "sendMessage", { chat_id: chat, text: `${text} ${EPHEMERAL_MARK}` });
	cleanups.push(sleep(EPHEMERAL_MS).then(() => removeMessage(env, chat, sent.message_id)));
}

// Оригінал, з якого почалась сесія (id сесії = tg-<чат>-<повідомлення>). У каналі його прибрано одразу, у приваті він лишається
// до видалення сесії; тут прибираємо лише приватний чат (id > 0), у каналі нічого не лишилось.
export function removeOriginal(env: BotEnv, chat: number, sessionId: string): Promise<unknown> {
	const [, origChat, origId] = /^tg-(-?\d+)-(\d+)$/.exec(sessionId) ?? [];
	if (!origId || Number(origChat) !== chat || chat < 0) return Promise.resolve();
	return removeMessage(env, chat, Number(origId));
}

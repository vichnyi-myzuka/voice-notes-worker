import type { Env } from "../env";
import { safeFileName } from "./utils";

export async function tg(env: Env, method: string, body: FormData | object): Promise<unknown> {
	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
		method: "POST",
		headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
		body: body instanceof FormData ? body : JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
	return res.json();
}

export async function tgSendMessage(env: Env, chatId: string | number, text: string): Promise<void> {
	await tg(env, "sendMessage", { chat_id: chatId, text });
}

// Надсилає нотатку в CHAT_ID і повертає message_id.
// Аудіо з Telegram пересилаємо за file_id (без повторного завантаження), з шорткату — завантажуємо.
export async function tgSendNote(
	env: Env,
	audio: { blob: () => Promise<Blob>; fileId?: string; kind?: string },
	title: string,
	caption: string,
	replyMarkup?: object,
): Promise<number> {
	const common = { chat_id: env.CHAT_ID, caption, ...(replyMarkup && { reply_markup: replyMarkup }) };
	let res: unknown;
	if (audio.fileId && audio.kind === "photo") {
		res = await tg(env, "sendPhoto", { ...common, photo: audio.fileId });
	} else if (audio.fileId && audio.kind === "voice") {
		res = await tg(env, "sendVoice", { ...common, voice: audio.fileId });
	} else if (audio.fileId) {
		res = await tg(env, "sendAudio", { ...common, audio: audio.fileId, title });
	} else {
		const form = new FormData();
		form.append("chat_id", env.CHAT_ID);
		form.append("audio", await audio.blob(), `${safeFileName(title)}.m4a`);
		form.append("title", title);
		form.append("caption", caption);
		if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
		res = await tg(env, "sendAudio", form);
	}
	return (res as { result: { message_id: number } }).result.message_id;
}

export const NO_PREVIEW = { is_disabled: true };

// Текстова нотатка: звичайне повідомлення (без аудіо). Повертає message_id.
export async function tgSendText(env: Env, text: string, entities: object[]): Promise<number> {
	// Без прев'ю посилань: інакше Telegram показує картку першої задачі Todoist («This content is private»).
	const res = await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text, entities, link_preview_options: NO_PREVIEW });
	return (res as { result: { message_id: number } }).result.message_id;
}

// Поки нотатка редагується, на ній стоїть 👨‍💻 (✏ серед реакцій для ботів немає).
export const markEditing = (env: Env, messageId: number, on: boolean) =>
	tg(env, "setMessageReaction", {
		chat_id: env.CHAT_ID,
		message_id: messageId,
		reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [],
	}).catch((err) => console.error("reaction failed:", err));

// Видаляє оригінальне голосове з каналу (якщо запис прийшов звідти). Збій не критичний.
export async function deleteOriginal(env: Env, meta: Record<string, string> | undefined): Promise<void> {
	const { deleteChatId, deleteMessageId } = meta ?? {};
	if (!deleteChatId || !deleteMessageId) return;
	await tg(env, "deleteMessage", { chat_id: deleteChatId, message_id: Number(deleteMessageId) }).catch((err) =>
		console.error("delete original message failed:", err),
	);
}

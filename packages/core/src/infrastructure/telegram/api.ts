import type { BotEnv, TelegramEnv } from "./env";
import type { TgEntity, TgMethods } from "./types";

// Викликає метод Bot API і повертає його result. FormData — для завантаження файлів.
export async function tg<M extends keyof TgMethods>(env: BotEnv, method: M, body: TgMethods[M]["params"] | FormData): Promise<TgMethods[M]["result"]> {
	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
		method: "POST",
		headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
		body: body instanceof FormData ? body : JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
	return (await res.json<{ result: TgMethods[M]["result"] }>()).result;
}

export async function tgSendMessage(env: BotEnv, chatId: string | number, text: string): Promise<void> {
	await tg(env, "sendMessage", { chat_id: chatId, text });
}

// Надсилає нотатку в CHAT_ID і повертає message_id.
// Аудіо з Telegram пересилаємо за file_id (без повторного завантаження), з шорткату — завантажуємо.
export async function tgSendNote(
	env: TelegramEnv,
	audio: { blob: () => Promise<Blob>; fileId?: string; kind?: string },
	title: string,
	caption: string,
): Promise<number> {
	const common = { chat_id: env.CHAT_ID, caption };
	let sent: { message_id: number };
	if (audio.fileId && audio.kind === "photo") {
		sent = await tg(env, "sendPhoto", { ...common, photo: audio.fileId });
	} else if (audio.fileId && audio.kind === "voice") {
		sent = await tg(env, "sendVoice", { ...common, voice: audio.fileId });
	} else if (audio.fileId) {
		sent = await tg(env, "sendAudio", { ...common, audio: audio.fileId, title });
	} else {
		const form = new FormData();
		form.append("chat_id", env.CHAT_ID);
		form.append("audio", await audio.blob(), `${safeFileName(title)}.m4a`);
		form.append("title", title);
		form.append("caption", caption);
		sent = await tg(env, "sendAudio", form);
	}
	return sent.message_id;
}

export const NO_PREVIEW = { is_disabled: true };

// Текстова нотатка: звичайне повідомлення (без аудіо). Повертає message_id.
export async function tgSendText(env: TelegramEnv, text: string, entities: TgEntity[]): Promise<number> {
	// Без прев'ю посилань: інакше Telegram показує картку першої задачі Todoist («This content is private»).
	const sent = await tg(env, "sendMessage", { chat_id: env.CHAT_ID, text, entities, link_preview_options: NO_PREVIEW });
	return sent.message_id;
}

// Поки нотатка редагується, на ній стоїть 👨‍💻 (✏ серед реакцій для ботів немає).
export const markEditing = (env: TelegramEnv, messageId: number, on: boolean) =>
	tg(env, "setMessageReaction", {
		chat_id: env.CHAT_ID,
		message_id: messageId,
		reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [],
	}).catch((err) => console.error("reaction failed:", err));

// Видаляє оригінальне голосове з каналу (якщо запис прийшов звідти). Збій не критичний.
export async function deleteOriginal(env: TelegramEnv, meta: Record<string, string> | undefined): Promise<void> {
	const { deleteChatId, deleteMessageId } = meta ?? {};
	if (!deleteChatId || !deleteMessageId) return;
	await tg(env, "deleteMessage", { chat_id: deleteChatId, message_id: Number(deleteMessageId) }).catch((err) =>
		console.error("delete original message failed:", err),
	);
}

// Посилання на повідомлення є лише в каналах і супергрупах (chat_id вигляду -100…).
export function telegramMessageUrl(chatId: string, messageId: number): string | null {
	return chatId.startsWith("-100") ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null;
}

export function safeFileName(name: string): string {
	const clean = name
		// oxlint-disable-next-line no-control-regex -- керівні символи в назві файлу прибираємо навмисно
		.replace(/[/\\:*?"<>|\x00-\x1f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return clean || "voice-note";
}

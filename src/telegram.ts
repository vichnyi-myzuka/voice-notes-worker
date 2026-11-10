import type { Env } from "./index";

// ---------- Bot API ----------
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
	if (audio.fileId && audio.kind === "voice") {
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

// Посилання на повідомлення є лише в каналах і супергрупах (chat_id вигляду -100…).
export function telegramMessageUrl(chatId: string, messageId: number): string | null {
	return chatId.startsWith("-100") ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null;
}

function safeFileName(name: string): string {
	const clean = name
		// oxlint-disable-next-line no-control-regex -- керівні символи в назві файлу прибираємо навмисно
		.replace(/[/\\:*?"<>|\x00-\x1f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return clean || "voice-note";
}

// ---------- Webhook: голосові в каналі CHAT_ID або в особистому чаті з ботом ----------
const DOWNLOAD_MAX_BYTES = 20_000_000; // ліміт Bot API на getFile

type TgFile = { file_id: string; file_size?: number; mime_type?: string };
type TgMessage = {
	message_id: number;
	date: number;
	chat: { id: number; type: string };
	from?: { id: number };
	text?: string;
	caption?: string;
	voice?: TgFile;
	audio?: TgFile;
	reply_to_message?: { message_id: number };
};

export type ReceivedVoice = {
	contentType: string;
	fileId?: string; // для тексту немає
	kind: string; // voice | audio | text
	// Голосове з каналу видаляється після публікації нотатки: нотатка містить те саме аудіо.
	deleteChatId?: string;
	deleteMessageId?: string;
	// Відповідь голосовим на нотатку в каналі: інструкція редагування цієї нотатки.
	replyTo?: string;
};

// ✍ (саме без U+FE0F, інакше REACTION_INVALID): запис прийнято. Не критично, якщо реакції вимкнені.
async function react(env: Env, msg: TgMessage): Promise<void> {
	await tg(env, "setMessageReaction", {
		chat_id: msg.chat.id,
		message_id: msg.message_id,
		reaction: [{ type: "emoji", emoji: "✍" }],
	}).catch((err) => console.error("reaction failed:", err));
}

// Приймає голосове чи аудіо й кладе в R2 і чергу (через store).
// Канал: лише дописи в CHAT_ID без підпису (у нотаток бота підпис є завжди), публікувати там можуть лише адміни.
// Особистий чат: лише від TG_OWNER_ID. В обох випадках ставимо ✍.
// Помилки повідомляє в чат сам; Telegram завжди отримує 200, щоб не повторював запит без кінця.
export async function receiveTelegramVoice(
	env: Env,
	msg: TgMessage,
	store: (key: string, body: ArrayBuffer, meta: ReceivedVoice) => Promise<void>,
): Promise<void> {
	const inChannel = msg.chat.type === "channel" && String(msg.chat.id) === env.CHAT_ID && !msg.caption;
	const inPrivate = msg.chat.type === "private" && !!env.TG_OWNER_ID && String(msg.from?.id) === env.TG_OWNER_ID;
	if (!inChannel && !inPrivate) return;

	const file = msg.voice ?? msg.audio;

	// Текстова відповідь на нотатку в каналі — інструкція редагування (без транскрипції).
	if (!file && inChannel && msg.text && msg.reply_to_message) {
		const key = `${msg.date * 1000}-${crypto.randomUUID().slice(0, 8)}.txt`;
		await store(key, new TextEncoder().encode(msg.text).buffer as ArrayBuffer, {
			contentType: "text/plain; charset=utf-8",
			kind: "text",
			deleteChatId: String(msg.chat.id),
			deleteMessageId: String(msg.message_id),
			replyTo: String(msg.reply_to_message.message_id),
		});
		await react(env, msg);
		return;
	}

	// Звичайний текст (не команда) — нова нотатка, як голосове, але без транскрипції.
	if (!file && msg.text?.trim() && !msg.text.trim().startsWith("/")) {
		const key = `${msg.date * 1000}-${crypto.randomUUID().slice(0, 8)}.txt`;
		await store(key, new TextEncoder().encode(msg.text).buffer as ArrayBuffer, {
			contentType: "text/plain; charset=utf-8",
			kind: "text",
			...(inChannel && { deleteChatId: String(msg.chat.id), deleteMessageId: String(msg.message_id) }),
		});
		await react(env, msg);
		return;
	}

	if (!file) {
		if (inPrivate && msg.text?.startsWith("/start")) {
			await tgSendMessage(env, msg.chat.id, "Надішли голосове, аудіофайл або текст: нотатка з'явиться в каналі.");
		}
		return;
	}
	if ((file.file_size ?? 0) > DOWNLOAD_MAX_BYTES) {
		await tgSendMessage(env, msg.chat.id, "⚠️ Файл більший за 20 МБ: бот не може його завантажити. Надішли запис через шорткат.");
		return;
	}

	try {
		const info = (await tg(env, "getFile", { file_id: file.file_id })) as { result: { file_path: string } };
		const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`);
		if (!res.ok) throw new Error(`download ${res.status}`);
		const kind = msg.voice ? "voice" : "audio";
		const contentType = file.mime_type ?? (kind === "voice" ? "audio/ogg" : "audio/mp4");
		const ext = kind === "voice" ? "ogg" : (info.result.file_path.split(".").pop() ?? "audio");
		// Ключ починається з часу запису (msg.date), як і для шорткату.
		const key = `${msg.date * 1000}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
		await store(key, await res.arrayBuffer(), {
			contentType,
			fileId: file.file_id,
			kind,
			...(inChannel && { deleteChatId: String(msg.chat.id), deleteMessageId: String(msg.message_id) }),
			...(inChannel && msg.reply_to_message && { replyTo: String(msg.reply_to_message.message_id) }),
		});
		await react(env, msg);
	} catch (err) {
		console.error("telegram voice failed:", err);
		await tgSendMessage(env, msg.chat.id, "⚠️ Не вдалося прийняти запис, спробуй ще раз.");
	}
}

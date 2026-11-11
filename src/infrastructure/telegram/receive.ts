import type { Env } from "../env";
import { tg, tgSendMessage } from "./api";
import type { StoreMessage, TgMessage } from "./types";

export const DOWNLOAD_MAX_BYTES = 20_000_000; // ліміт Bot API на getFile

// ✍ (саме без U+FE0F, інакше REACTION_INVALID): запис прийнято. Не критично, якщо реакції вимкнені.
export async function react(env: Env, msg: TgMessage): Promise<void> {
	await tg(env, "setMessageReaction", {
		chat_id: msg.chat.id,
		message_id: msg.message_id,
		reaction: [{ type: "emoji", emoji: "✍" }],
	}).catch((err) => console.error("reaction failed:", err));
}

// Приймає голосове, аудіо, текст чи фото й кладе в R2 і чергу (через store).
// Канал: лише дописи в CHAT_ID без підпису (у нотаток бота підпис є завжди), публікувати там можуть лише адміни.
// Особистий чат: лише від TG_OWNER_ID. В обох випадках ставимо ✍.
// Помилки повідомляє в чат сам; Telegram завжди отримує 200, щоб не повторював запит без кінця.
export async function receiveTelegramMessage(
	env: Env,
	msg: TgMessage,
	store: StoreMessage,
): Promise<void> {
	// Фото приймаємо й з підписом: підпис — частина нотатки (власних дописів бот у вебхуку не отримує).
	const inChannel = msg.chat.type === "channel" && String(msg.chat.id) === env.CHAT_ID && (!msg.caption || !!msg.photo);
	const inPrivate = msg.chat.type === "private" && !!env.TG_OWNER_ID && String(msg.from?.id) === env.TG_OWNER_ID;
	if (!inChannel && !inPrivate) return;

	const photo = msg.photo?.at(-1); // найбільший розмір
	const file = msg.voice ?? msg.audio ?? photo;

	// Текстова відповідь на нотатку в каналі — інструкція редагування (без транскрипції).
	if (!file && inChannel && msg.text && msg.reply_to_message) {
		const key = `${msg.date * 1000}-${crypto.randomUUID().slice(0, 8)}.txt`;
		const accepted = await store(key, await new Blob([msg.text]).arrayBuffer(), {
			contentType: "text/plain; charset=utf-8",
			kind: "text",
			deleteChatId: String(msg.chat.id),
			deleteMessageId: String(msg.message_id),
			replyTo: String(msg.reply_to_message.message_id),
		});
		if (accepted) await react(env, msg);
		return;
	}

	// Звичайний текст (не команда) — нова нотатка, як голосове, але без транскрипції.
	if (!file && msg.text?.trim() && !msg.text.trim().startsWith("/")) {
		const key = `${msg.date * 1000}-${crypto.randomUUID().slice(0, 8)}.txt`;
		const accepted = await store(key, await new Blob([msg.text]).arrayBuffer(), {
			contentType: "text/plain; charset=utf-8",
			kind: "text",
			...(inChannel && { deleteChatId: String(msg.chat.id), deleteMessageId: String(msg.message_id) }),
		});
		if (accepted) await react(env, msg);
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
		const info = await tg(env, "getFile", { file_id: file.file_id });
		const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
		if (!res.ok) throw new Error(`download ${res.status}`);
		const kind = photo ? "photo" : msg.voice ? "voice" : "audio";
		// Фото в Telegram завжди JPEG.
		const contentType = photo ? "image/jpeg" : (file.mime_type ?? (kind === "voice" ? "audio/ogg" : "audio/mp4"));
		const ext = photo ? "jpg" : kind === "voice" ? "ogg" : (info.file_path.split(".").pop() ?? "audio");
		// Ключ починається з часу запису (msg.date), як і для шорткату.
		const key = `${msg.date * 1000}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
		const accepted = await store(key, await res.arrayBuffer(), {
			contentType,
			fileId: file.file_id,
			kind,
			...(inChannel && { deleteChatId: String(msg.chat.id), deleteMessageId: String(msg.message_id) }),
			// Фото — завжди нова нотатка, навіть у відповідь на іншу (правки фото поки не вміють).
			...(inChannel && !photo && msg.reply_to_message && { replyTo: String(msg.reply_to_message.message_id) }),
			...(photo && msg.caption?.trim() && { caption: msg.caption.trim() }),
		});
		if (accepted) await react(env, msg);
	} catch (err) {
		console.error("telegram voice failed:", err);
		await tgSendMessage(env, msg.chat.id, "⚠️ Не вдалося прийняти запис, спробуй ще раз.");
	}
}

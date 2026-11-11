import type { Channel, Incoming, OnIncoming } from "../../domain/channel";
import type { Env } from "../env";
import { safeEqual } from "../security";
import { NO_PREVIEW, deleteOriginal, markEditing, telegramMessageUrl, tg, tgSendMessage, tgSendNote, tgSendText } from "./api";
import { receiveTelegramMessage } from "./receive";
import type { ReceivedMessage, TgEntity, TgUpdate } from "./types";

export const CAPTION_MAX = 1024; // ліміт підпису до аудіо в Telegram
export const TEXT_CAPTION_MAX = 3500; // текстова нотатка (ліміт повідомлення 4096): решта — під цитату оригіналу
const TEXT_MAX = 4096; // ліміт повідомлення Telegram (UTF-16)

// Текстова нотатка: підпис, а під ним оригінальний текст у згорнутій цитаті (як аудіо в голосовій нотатці).
// Довгий оригінал обрізається.
export function textNote(caption: string, original: string, entities: TgEntity[] = []): { text: string; entities: TgEntity[] } {
	const room = TEXT_MAX - caption.length - 2;
	let cut = room - 1;
	if (/[\uD800-\uDBFF]/.test(original[cut - 1] ?? "")) cut--; // не розрізаємо emoji (сурогатну пару)
	const quote = original.length > room ? `${original.slice(0, cut)}…` : original;
	return {
		text: `${caption}\n\n${quote}`,
		entities: [...entities, { type: "expandable_blockquote", offset: caption.length + 2, length: quote.length }],
	};
}

// Вебхук: перевірка секрета, розбір оновлення, передача запису ядру.
async function webhook(env: Env, req: Request, onIncoming: OnIncoming): Promise<Response> {
	const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (!env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
		return new Response("unauthorized", { status: 401 });
	}
	const update = await req.json<TgUpdate>();
	const msg = update.message ?? update.channel_post;
	if (msg) await receiveTelegramMessage(env, msg, (key, body, received) => onIncoming(key, body, toIncoming(received)));
	return new Response("ok");
}

function toIncoming({ contentType, caption, replyTo, kind, fileId, deleteChatId, deleteMessageId }: ReceivedMessage): Incoming {
	return {
		contentType,
		caption,
		replyTo,
		metadata: { kind, ...(fileId && { fileId }) },
		origin: deleteChatId && deleteMessageId ? { deleteChatId, deleteMessageId } : undefined,
	};
}

// Адаптер Channel для Telegram: нотатки публікуються в CHAT_ID.
export function telegramChannel(env: Env): Channel {
	return {
		limits: { caption: CAPTION_MAX, textNote: TEXT_CAPTION_MAX },
		webhookPath: "/telegram",
		webhook: (req, onIncoming) => webhook(env, req, onIncoming),
		linkTo: (messageId) => telegramMessageUrl(env.CHAT_ID, messageId),
		// Аудіо з Telegram пересилаємо за file_id, з шорткату — завантажуємо в Telegram заново.
		publishRecording: (recording, title, caption) =>
			tgSendNote(env, { blob: recording.blob, fileId: recording.metadata?.fileId, kind: recording.metadata?.kind }, title, caption),
		publishText: (caption, original) => {
			const { text, entities } = textNote(caption, original);
			return tgSendText(env, text, entities);
		},
		update: async (messageId, caption, links, original) => {
			const entities: TgEntity[] = links.map((link) => ({ type: "text_link", ...link }));
			const common = { chat_id: env.CHAT_ID, message_id: messageId };
			try {
				if (original === undefined) await tg(env, "editMessageCaption", { ...common, caption, caption_entities: entities });
				else await tg(env, "editMessageText", { ...common, ...textNote(caption, original, entities), link_preview_options: NO_PREVIEW });
			} catch (err) {
				if (!String(err).includes("message is not modified")) throw err;
			}
		},
		remove: async (messageId) => {
			await tg(env, "deleteMessage", { chat_id: env.CHAT_ID, message_id: messageId }).catch((err) => console.error("delete note message failed:", err));
		},
		setBusy: async (messageId, busy) => {
			await markEditing(env, messageId, busy);
		},
		removeOrigin: (metadata) => deleteOriginal(env, metadata),
		say: (text) => tgSendMessage(env, env.CHAT_ID, text),
	};
}

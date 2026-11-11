import { noteIdByMessage } from "../../domain/published";
import { captionKey } from "../../domain/recording";
import type { Env } from "../../infrastructure/env";
import { deleteOriginal, markEditing, receiveTelegramVoice, type ReceivedVoice, type TgUpdate } from "../../infrastructure/telegram";
import { enqueueNote, safeEqual } from "./enqueue";

// Відповідь на повідомлення, що не є нашою нотаткою (або застаріла): обробка повідомить про це користувача.
const MISSING_NOTE = "missing";

// Вебхук Telegram: голосові, текст і фото (канал і приват).
export async function telegramWebhook(req: Request, env: Env): Promise<Response> {
	const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (!env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
		return new Response("unauthorized", { status: 401 });
	}
	const update = await req.json<TgUpdate>();
	const msg = update.message ?? update.channel_post;
	if (msg) await receiveTelegramVoice(env, msg, (key, body, incoming) => accept(env, key, body, incoming));
	return new Response("ok");
}

// Ставить запис у чергу. Повертає true, якщо оригінал у каналі лишається (нова нотатка),
// і false, якщо його вже прибрано (правка існуючої нотатки).
async function accept(
	env: Env,
	key: string,
	body: ArrayBuffer,
	{ contentType, replyTo, caption, deleteChatId, deleteMessageId, ...metadata }: ReceivedVoice,
): Promise<boolean> {
	if (caption) await env.BUCKET.put(captionKey(key), caption);
	// Відповідь на повідомлення в каналі = редагування цієї нотатки.
	const edit = replyTo ? (await noteIdByMessage(env, replyTo)) || MISSING_NOTE : undefined;
	if (!replyTo || edit === MISSING_NOTE) {
		// Нова нотатка або відповідь не на нашу: оригінал лишається в каналі (його видалить обробка).
		await enqueueNote(env, { key, body, contentType, metadata: { ...metadata, deleteChatId, deleteMessageId }, edit });
		return true;
	}
	// Правка: відповідь одразу прибираємо з каналу, а статус «редагується» (👨‍💻) — на самій нотатці.
	await enqueueNote(env, { key, body, contentType, metadata, edit });
	await markEditing(env, Number(replyTo), true);
	await deleteOriginal(env, { deleteChatId: deleteChatId ?? "", deleteMessageId: deleteMessageId ?? "" });
	return false;
}

import type { Env } from "../../infrastructure/env";
import { noteIdByMessage } from "../../domain/published";
import { captionKey } from "../../domain/recording";
import { deleteOriginal, markEditing, receiveTelegramVoice, type TgUpdate } from "../../infrastructure/telegram";

export async function handleFetch(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);

	// Вебхук Telegram: голосові, текст і фото (канал і приват).
	if (url.pathname === "/telegram" && req.method === "POST") {
		const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
		if (!env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
			return new Response("unauthorized", { status: 401 });
		}
		const update = await req.json<TgUpdate>();
		const msg = update.message ?? update.channel_post;
		if (msg) {
			await receiveTelegramVoice(env, msg, async (key, body, { contentType, replyTo, caption, ...meta }) => {
				if (caption) await env.BUCKET.put(captionKey(key), caption);
				// Відповідь на повідомлення в каналі = редагування; "missing", якщо це не наша нотатка або вона застаріла.
				const edit = replyTo && ((await noteIdByMessage(env, replyTo)) || "missing");
				if (!edit || edit === "missing") {
					await enqueueNote(env, key, body, contentType, meta, edit || undefined);
					return true;
				}
				// Правка: відповідь одразу прибираємо з каналу, а статус «редагується» (👨‍💻) — на самій нотатці.
				const { deleteChatId, deleteMessageId, ...rest } = meta;
				await enqueueNote(env, key, body, contentType, rest, edit);
				await markEditing(env, Number(replyTo), true);
				await deleteOriginal(env, { deleteChatId: deleteChatId ?? "", deleteMessageId: deleteMessageId ?? "" });
				return false;
			});
		}
		return new Response("ok");
	}

	// Шорткат: сирий файл у тілі або форма з полем audio (інші поля ігноруються).
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	if (!env.SECRET) return new Response("SECRET is not configured", { status: 500 });
	if (!(await safeEqual(req.headers.get("x-secret") ?? "", env.SECRET))) {
		return new Response("unauthorized", { status: 401 });
	}

	// Тіло читаємо повністю (не стрімом): R2 put потребує відомої довжини.
	let body: ArrayBuffer;
	if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
		const audio = (await req.formData()).get("audio");
		if (!audio || typeof audio === "string") return new Response("missing audio field", { status: 400 });
		body = await audio.arrayBuffer();
	} else {
		body = await req.arrayBuffer();
	}
	if (body.byteLength === 0) return new Response("empty body", { status: 400 });

	const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.m4a`;
	await enqueueNote(env, key, body, "audio/mp4");
	return new Response("ok");
}

// Кладе аудіо в R2 і ставить у чергу.
export async function enqueueNote(
	env: Env,
	key: string,
	body: ArrayBuffer,
	contentType: string,
	customMetadata?: Record<string, string | undefined>,
	edit?: string,
): Promise<void> {
	const meta = Object.fromEntries(Object.entries(customMetadata ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
	await env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: meta });
	await env.QUEUE.send(edit ? { key, edit } : { key });
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

import type { Env } from "../../infrastructure/env";
import { enqueueNote, safeEqual } from "./enqueue";
import { telegramWebhook } from "./telegram";

// POST /telegram — вебхук Telegram; будь-який інший POST — завантаження з шорткату.
export async function handleFetch(req: Request, env: Env): Promise<Response> {
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	return new URL(req.url).pathname === "/telegram" ? telegramWebhook(req, env) : shortcutUpload(req, env);
}

// Шорткат: сирий файл у тілі або форма з полем audio (інші поля ігноруються).
async function shortcutUpload(req: Request, env: Env): Promise<Response> {
	if (!env.SECRET) return new Response("SECRET is not configured", { status: 500 });
	if (!(await safeEqual(req.headers.get("x-secret") ?? "", env.SECRET))) return new Response("unauthorized", { status: 401 });

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
	await enqueueNote(env, { key, body, contentType: "audio/mp4" });
	return new Response("ok");
}

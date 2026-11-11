import type { Env } from "../../infrastructure/env";
import { shortcutUpload } from "./shortcut";
import { telegramWebhook } from "./telegram";

// POST /telegram — вебхук Telegram; будь-який інший POST — завантаження з шорткату.
export async function handleFetch(req: Request, env: Env): Promise<Response> {
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	return new URL(req.url).pathname === "/telegram" ? telegramWebhook(req, env) : shortcutUpload(req, env);
}

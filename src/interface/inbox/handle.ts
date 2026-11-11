import type { Env } from "../../infrastructure/env";
import type { Channel } from "../../domain/channel";
import { acceptIncoming } from "./accept";
import { shortcutUpload } from "./shortcut";

// POST на шлях вебхука каналу — запис із каналу; будь-який інший POST — завантаження з шорткату.
export async function handleFetch(req: Request, env: Env, channel: Channel): Promise<Response> {
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	if (new URL(req.url).pathname !== channel.webhookPath) return shortcutUpload(req, env);
	return channel.webhook(req, (key, body, incoming) => acceptIncoming(env, channel, key, body, incoming));
}

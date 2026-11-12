import type { Env } from "../../infrastructure/env";
import type { Ports } from "../../application/pipeline";
import { acceptIncoming } from "../../application/intake";
import { shortcutUpload } from "./shortcut";

// POST на шлях вебхука каналу — запис із каналу; будь-який інший POST — завантаження з шорткату.
export async function handleFetch(req: Request, env: Env, ports: Ports): Promise<Response> {
	if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
	const { channel } = ports;
	if (new URL(req.url).pathname !== channel.webhookPath) return shortcutUpload(req, env, ports.recordings);
	return channel.webhook(req, (key, body, incoming) => acceptIncoming(env, ports, key, body, incoming));
}

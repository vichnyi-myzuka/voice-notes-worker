import { verifyAccess } from "@voice-notes/core";
import type { Env } from "../../env";

// Перевірка Cloudflare Access у воркері (другий рівень захисту поверх самого Access). undefined — запит пропущено,
// інакше готова відмова. LOCAL_DEV (лише `npm run dev`) вимикає перевірку.
// extraAud: AUD ще одного застосунку Access, що теж пропускає цей запит (окремий застосунок на шлях /agent-api).
export async function denyUnlessAccess(req: Request, env: Env, extraAud?: string): Promise<Response | undefined> {
	if (env.LOCAL_DEV) return undefined;
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
	const teamDomain = env.ACCESS_TEAM_DOMAIN;
	for (const aud of [env.ACCESS_AUD, extraAud]) if (aud && (await verifyAccess(req, { teamDomain, aud }))) return undefined;
	return new Response("Forbidden", { status: 403 });
}

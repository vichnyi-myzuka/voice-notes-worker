import { verifyAccess } from "@voice-notes/core";
import type { Env } from "../../env";

// Перевірка Cloudflare Access у воркері (другий рівень захисту поверх самого Access). undefined — запит пропущено,
// інакше готова відмова. LOCAL_DEV (лише `npm run dev`) вимикає перевірку.
export async function denyUnlessAccess(req: Request, env: Env): Promise<Response | undefined> {
	if (env.LOCAL_DEV) return undefined;
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
	if (!(await verifyAccess(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }))) return new Response("Forbidden", { status: 403 });
	return undefined;
}

import { verifyAccess } from "@voice-notes/core";
import type { Env } from "./env";
import { serveSite } from "./serve";

export type { Env } from "./env";

export default {
	async fetch(req, env) {
		if (!env.LOCAL_DEV) {
			if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
			if (!(await verifyAccess(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }))) return new Response("Forbidden", { status: 403 });
		}
		return serveSite(req, env);
	},
} satisfies ExportedHandler<Env>;

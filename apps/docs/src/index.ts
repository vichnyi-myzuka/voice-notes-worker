import { verifyAccess } from "@voice-notes/core";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
	async fetch(req, env) {
		if (!env.LOCAL_DEV) {
			if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
			if (!(await verifyAccess(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }))) return new Response("Forbidden", { status: 403 });
		}
		if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
		const res = await env.ASSETS.fetch(req);
		const out = new Response(res.body, res);
		out.headers.set("x-content-type-options", "nosniff");
		out.headers.set("x-robots-tag", "noindex");
		out.headers.set("cache-control", "no-cache");
		return out;
	},
} satisfies ExportedHandler<Env>;

import type { Env } from "../../env";
import { verifyAccess } from "../../infrastructure/access";

const COOKIE = "agent_session";
const ID = /^[a-z0-9-]{8,64}$/;

// Маршрути (усе за Cloudflare Access):
//   POST /api/sessions {prompt, repo?, id?} → {id, url}: створює сесію й повертає посилання
//   GET  /s/<id>                            → запам'ятовує сесію в cookie й веде у веб-інтерфейс OpenCode
//   будь-що інше                            → проксі у веб-інтерфейс сесії з cookie
// Веб-інтерфейс OpenCode використовує абсолютні шляхи, тому сесію вибирає cookie, а не префікс шляху.
export async function handleFetch(req: Request, env: Env): Promise<Response> {
	if (!env.LOCAL_DEV) {
		if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
		if (!(await verifyAccess(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }))) return new Response("Forbidden", { status: 403 });
	}
	const url = new URL(req.url);

	if (req.method === "POST" && url.pathname === "/api/sessions") return createSession(req, env, url);

	const link = url.pathname.match(/^\/s\/([^/]+)\/?$/);
	if (link) {
		if (!ID.test(link[1])) return new Response("Bad session id", { status: 400 });
		return new Response(null, {
			status: 302,
			headers: { location: "/", "set-cookie": `${COOKIE}=${link[1]}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000` },
		});
	}

	const id = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
	if (!id || !ID.test(id)) return new Response("No session selected. Open the session link from the chat.", { status: 404 });
	return env.AGENT_SESSION.getByName(id).fetch(req);
}

async function createSession(req: Request, env: Env, url: URL): Promise<Response> {
	const body = await req.json<{ prompt?: string; repo?: string; id?: string }>().catch(() => null);
	if (!body?.prompt?.trim()) return Response.json({ error: "prompt is required" }, { status: 400 });
	const id = body.id ?? crypto.randomUUID();
	if (!ID.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
	if (body.repo && !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(body.repo)) return Response.json({ error: "bad repo" }, { status: 400 });
	await env.AGENT_SESSION.getByName(id).start({ prompt: body.prompt, repo: body.repo });
	return Response.json({ id, url: `${url.origin}/s/${id}` });
}

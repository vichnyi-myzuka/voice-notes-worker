import type { Agent } from "../../domain/agent";
import type { Env } from "../../env";
import { verifyAccess } from "../../infrastructure/access";

const COOKIE = "agent_session";
const ID = /^[a-z0-9-]{8,64}$/;
const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

const NEUTRAL_SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim())));
`;

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Маршрути (усе за Cloudflare Access):
//   POST /api/sessions {prompt, repo?, id?}   → {id, url}: створює сесію (ідемпотентно за id) й повертає посилання
//   GET  /api/sessions/<id>                   → {status}: working | idle | stopped
//   POST /api/sessions/<id>/messages {text}   → уточнення в ту саму сесію
//   POST /api/sessions/<id>/abort             → зупиняє поточну роботу агента
//   GET  /s/<id>                              → запам'ятовує сесію в cookie й веде у веб-інтерфейс OpenCode
//   будь-що інше                              → проксі у веб-інтерфейс сесії з cookie
// Веб-інтерфейс OpenCode використовує абсолютні шляхи, тому сесію вибирає cookie, а не префікс шляху.
export async function handleFetch(req: Request, env: Env, agent: Agent): Promise<Response> {
	if (!env.LOCAL_DEV) {
		if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
		if (!(await verifyAccess(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }))) return new Response("Forbidden", { status: 403 });
	}
	const url = new URL(req.url);

	if (req.method === "POST" && url.pathname === "/api/sessions") return create(req, agent);

	const api = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|abort))?$/);
	if (api) {
		const [, id, action] = api;
		if (!ID.test(id)) return json({ error: "bad id" }, 400);
		if (!action && req.method === "GET") return json({ status: await agent.status(id) });
		if (action === "abort" && req.method === "POST") return agent.abort(id).then(() => json({ ok: true }));
		if (action === "messages" && req.method === "POST") {
			const body = await req.json<{ text?: string }>().catch(() => null);
			if (!body?.text?.trim()) return json({ error: "text is required" }, 400);
			await agent.followUp(id, body.text);
			return json({ ok: true });
		}
		return json({ error: "not found" }, 404);
	}

	// Service worker OpenCode кешує оболонку застосунку й віддає її на будь-яку адресу, зокрема /s/<id>, так що запит не доходить
	// до воркера («Unrecognised route»). Підміняємо його порожнім: без fetch-обробника все йде через мережу.
	if (url.pathname === "/sw.js") return new Response(NEUTRAL_SW, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });

	const current = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
	const link = url.pathname.match(/^\/s\/([^/]+)\/?$/);
	if (link) {
		if (!ID.test(link[1])) return new Response("Bad session id", { status: 400 });
		// Усі сесії на одному домені, а інтерфейс OpenCode тримає в localStorage маршрути й вкладки попередньої сесії:
		// у новому контейнері їх немає («Unrecognised route»). Тому при зміні сесії чистимо стан браузера.
		const headers = new Headers({
			"content-type": "text/html; charset=utf-8",
			"set-cookie": `${COOKIE}=${link[1]}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
			"cache-control": "no-store",
		});
		if (current !== link[1]) headers.set("clear-site-data", '"storage"');
		// Сторінка, а не 302: заголовок надійніше обробляється у звичайній відповіді.
		return new Response('<!doctype html><meta charset="utf-8"><script>location.replace("/")</script><a href="/">Відкрити</a>', { headers });
	}

	const id = current;
	if (!id || !ID.test(id)) return new Response("No session selected. Open the session link from the chat.", { status: 404 });
	return agent.serve(id, req);
}

async function create(req: Request, agent: Agent): Promise<Response> {
	const body = await req.json<{ prompt?: string; repo?: string; id?: string }>().catch(() => null);
	if (!body?.prompt?.trim()) return json({ error: "prompt is required" }, 400);
	const id = body.id ?? crypto.randomUUID();
	if (!ID.test(id)) return json({ error: "bad id" }, 400);
	if (body.repo && !REPO.test(body.repo)) return json({ error: "bad repo" }, 400);
	return json(await agent.start(id, { prompt: body.prompt, repo: body.repo }));
}

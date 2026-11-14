import type { CalendarLogin, Computer, Sessions, SilpoLogin } from "../../domain/agent";
import { preview, type NewSchedule, type Outcome, type SchedulePatch, type Schedules } from "../../domain/schedule";
import { AUTOMATIONS_HTML } from "./automations-page";
import type { Env } from "../../env";
import { verifyAccess } from "@voice-notes/core";

const ID = /^[a-z0-9-]{8,64}$/;
const SCHEDULE_ID = /^[a-f0-9]{8}$/;
const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

const NEUTRAL_SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim())));
`;

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Маршрути (усе за Cloudflare Access):
//   POST /api/sessions {prompt, repo?, id?}   → {id, url}: створює сесію (ідемпотентно за id) й повертає посилання
//   GET  /api/sessions/<id>                   → {status}: working | idle | stopped
//   POST /api/sessions/<id>/messages {text}   → уточнення в ту саму сесію
//   DELETE /api/sessions/<id>                 → видаляє сесію: історію й теку (гілка agent/<id> лишається)
//   POST /api/sessions/<id>/abort             → зупиняє поточну роботу агента
//   GET  /api/schedules, POST /api/schedules {name, prompt, at | cron+tz?, repo?, model?, expiresAt?}  → розклади автоматизацій (ADR 0005)
//   GET|PATCH|DELETE /api/schedules/<id>      → один розклад: читання, зміна полів, видалення
//   POST /api/schedules/<id>/pause|resume|run → пауза, відновлення (і підтвердження розкладу від агента), запуск зараз
//   GET  /api/schedules/<id>/runs             → історія запусків
//   POST /api/schedules/preview {at | cron+tz?} → {times}: найближчі запуски для форми (ті самі перевірки, що й при створенні)
//   GET  /automations                         → веб-сторінка автоматизацій (таблиця, форма, історія) над /api/schedules
//   GET  /silpo/login, /silpo/callback        → вхід у Сільпо (OAuth для MCP): редірект на Сільпо і завершення входу
//   GET  /calendar/login, /calendar/callback  → вхід у Google Calendar (OAuth для MCP Google Workspace): те саме
//   GET  /api/computer                        → стан контейнера для діагностики (чому не засинає, відкриті SSE-потоки)
//   GET  /api/computer/connections            → running; з ?detail=1 ще й SSH-з'єднання (exec продовжує життя контейнера)
//   POST /api/computer/snapshot                      → примусово зберігає диск контейнера (після змін поза сесіями, наприклад через SSH)
//   DELETE /api/computer/snapshot             → видаляє знімок і зупиняє контейнер: наступний старт з чистого образу (сесії зникають)
//   GET  /s/<id>                              → редірект на сторінку цієї сесії у веб-інтерфейсі OpenCode
//   будь-що інше                              → проксі у веб-інтерфейс OpenCode (спільний контейнер, усі сесії в одному списку)
export async function handleFetch(req: Request, env: Env, agent: Sessions & Computer & SilpoLogin & CalendarLogin, schedules?: Schedules): Promise<Response> {
	if (!env.LOCAL_DEV) {
		if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 503 });
		if (!(await verifyAccess(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }))) return new Response("Forbidden", { status: 403 });
	}
	const url = new URL(req.url);

	if (req.method === "POST" && url.pathname === "/api/sessions") return create(req, agent);

	if (schedules && url.pathname.startsWith("/api/schedules")) return scheduleApi(req, url, schedules);
	if (schedules && req.method === "GET" && (url.pathname === "/automations" || url.pathname === "/automations/")) return new Response(AUTOMATIONS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

	const api = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|abort))?$/);
	if (api) {
		const [, id, action] = api;
		if (!ID.test(id)) return json({ error: "bad id" }, 400);
		if (!action && req.method === "GET") return json({ status: await agent.status(id) });
		if (!action && req.method === "DELETE") return agent.remove(id).then(() => json({ ok: true }));
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

	// Вхід у Сільпо: /silpo/login веде на сторінку входу Сільпо, звідти браузер повертається на /silpo/callback (теж за Access).
	if (req.method === "GET" && url.pathname === "/silpo/login") {
		return new Response(null, { status: 302, headers: { location: await agent.silpoLoginUrl(url.origin), "cache-control": "no-store" } });
	}
	if (req.method === "GET" && url.pathname === "/silpo/callback") {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const ok = code && state ? await agent.silpoCallback(code, state).catch(() => false) : false;
		const page = (text: string, status: number) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Сільпо</title><p style="font:18px system-ui;margin:2em">${text}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		return ok ? page("✅ Сільпо підключено. Можна повертатись у чат.", 200) : page("⚠️ Не вдалося підключити Сільпо. Відкрий /silpo/login ще раз.", 400);
	}

	// Вхід у Google Calendar: так само; без GOOGLE_CLIENT_ID/SECRET вхід неможливий (503).
	if (req.method === "GET" && url.pathname === "/calendar/login") {
		const to = await agent.calendarLoginUrl(url.origin).catch(() => undefined);
		if (!to) return new Response("Google Calendar не налаштовано (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)", { status: 503 });
		return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
	}
	if (req.method === "GET" && url.pathname === "/calendar/callback") {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const ok = code && state ? await agent.calendarCallback(code, state).catch(() => false) : false;
		const page = (text: string, status: number) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Календар</title><p style="font:18px system-ui;margin:2em">${text}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		return ok ? page("✅ Календар підключено. Можна повертатись у чат.", 200) : page("⚠️ Не вдалося підключити Календар. Відкрий /calendar/login ще раз.", 400);
	}

	if (req.method === "GET" && url.pathname === "/api/computer/connections") return json(await agent.connections(url.searchParams.get("detail") === "1"));
	if (req.method === "GET" && url.pathname === "/api/computer") return json(await agent.info());

	if (req.method === "POST" && url.pathname === "/api/computer/snapshot") {
		return agent.snapshot().then(
			(info) => json(info),
			(err: unknown) => json({ error: err instanceof Error ? err.message : String(err) }, 409),
		);
	}

	if (req.method === "DELETE" && url.pathname === "/api/computer/snapshot") {
		await agent.resetComputer();
		return json({ ok: true });
	}

	const link = url.pathname.match(/^\/s\/([^/]+)\/?$/);
	if (link) {
		if (!ID.test(link[1])) return new Response("Bad session id", { status: 400 });
		const ocId = await agent.link(link[1]);
		if (!ocId) return new Response("Unknown session", { status: 404 });
		return new Response(null, { status: 302, headers: { location: sessionPath(url.origin, ocId), "cache-control": "no-store" } });
	}

	// Service worker OpenCode кешує оболонку застосунку й віддає її на будь-яку адресу, зокрема /s/<id>, так що запит не доходить
	// до воркера («Unrecognised route»). Підміняємо його порожнім: без fetch-обробника все йде через мережу.
	if (url.pathname === "/sw.js") return new Response(NEUTRAL_SW, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });

	return agent.serve(req);
}

// Сторінка сесії в інтерфейсі OpenCode: /server/<ключ сервера>/session/<id>, де ключ — base64url адреси сервера (без «=»).
// Для сервера на тому самому домені це origin; перевірено лише за кодом інтерфейсу, тож перевіряється в браузері.
const sessionPath = (origin: string, ocId: string) => `/server/${btoa(origin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}/session/${ocId}`;

async function create(req: Request, agent: Sessions & Computer): Promise<Response> {
	const body = await req.json<{ prompt?: string; repo?: string; id?: string }>().catch(() => null);
	if (!body?.prompt?.trim()) return json({ error: "prompt is required" }, 400);
	const id = body.id ?? crypto.randomUUID();
	if (!ID.test(id)) return json({ error: "bad id" }, 400);
	if (body.repo && !REPO.test(body.repo)) return json({ error: "bad repo" }, 400);
	return json(await agent.start(id, { prompt: body.prompt, repo: body.repo }));
}

const OUTCOME_STATUS = { invalid: 400, limit: 409, not_found: 404 } as const;
const outcome = <T>(o: Outcome<T>, field: string) => (o.ok ? json({ [field]: o.value }) : json({ error: o.error }, OUTCOME_STATUS[o.code]));

// Розклади автоматизацій: усі правила й ліміти живуть у Scheduler, тут лише розбір запиту.
async function scheduleApi(req: Request, url: URL, schedules: Schedules): Promise<Response> {
	if (url.pathname === "/api/schedules/preview") {
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		const body = await req.json<NewSchedule>().catch(() => null);
		if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
		return outcome(preview({ at: body.at, cron: body.cron, tz: body.tz }, Date.now()), "times");
	}
	const m = url.pathname.match(/^\/api\/schedules(?:\/([^/]+)(?:\/(pause|resume|run|runs))?)?$/);
	if (!m) return json({ error: "not found" }, 404);
	const [, id, action] = m;
	if (!id) {
		if (req.method === "GET") return json({ schedules: await schedules.list() });
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		const body = await req.json<NewSchedule>().catch(() => null);
		if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
		return outcome(await schedules.create(body, "owner", url.origin), "schedule");
	}
	if (!SCHEDULE_ID.test(id)) return json({ error: "bad id" }, 400);
	if (!action) {
		if (req.method === "GET") {
			const s = await schedules.get(id);
			return s ? json({ schedule: s }) : json({ error: "no such schedule" }, 404);
		}
		if (req.method === "DELETE") return (await schedules.remove(id)) ? json({ ok: true }) : json({ error: "no such schedule" }, 404);
		if (req.method === "PATCH") {
			const body = await req.json<SchedulePatch>().catch(() => null);
			if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
			return outcome(await schedules.update(id, body), "schedule");
		}
		return json({ error: "method not allowed" }, 405);
	}
	if (action === "runs" && req.method === "GET") {
		const s = await schedules.get(id);
		return s ? json({ runs: s.runs }) : json({ error: "no such schedule" }, 404);
	}
	if (req.method !== "POST" || action === "runs") return json({ error: "method not allowed" }, 405);
	if (action === "pause") return outcome(await schedules.pause(id), "schedule");
	if (action === "resume") return outcome(await schedules.resume(id), "schedule");
	return outcome(await schedules.runNow(id), "run");
}

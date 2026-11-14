import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleFetch } from "../src/interface/http";
import { fakeAgent } from "./fake-agent";

// LOCAL_DEV вимикає Access; перевірку токена окремо покриває access.test.ts.
const env = { LOCAL_DEV: "1", OPENCODE_PASSWORD: "pw" } as unknown as Env;
const accessEnv = { OPENCODE_PASSWORD: "pw" } as unknown as Env;

const ID = "session-0001";
const call = (path: string, method = "GET", body?: unknown, headers: HeadersInit = {}) =>
	new Request(`https://agent.example${path}`, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });

describe("захист", () => {
	it("без налаштованого Access відповідає 503, з чужим токеном — 403", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call("/"), accessEnv, agent)).status).toBe(503);
		const configured = { ...accessEnv, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" } as Env;
		expect((await handleFetch(call("/"), configured, agent)).status).toBe(403);
		expect((await handleFetch(call("/api/sessions", "POST", { prompt: "x" }), configured, agent)).status).toBe(403);
	});
});

describe("сесія від створення до зупинки", () => {
	it("створення → статус → уточнення → зупинка → уточнення після зупинки", async () => {
		const { agent, sessions } = fakeAgent();

		const created = await handleFetch(call("/api/sessions", "POST", { prompt: "Поправ README", repo: "me/app", id: ID }), env, agent);
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({ id: ID, url: `https://agent.example/s/${ID}` });
		expect(sessions.get(ID)?.input).toEqual({ prompt: "Поправ README", repo: "me/app" });

		expect(await (await handleFetch(call(`/api/sessions/${ID}`), env, agent)).json()).toEqual({ status: "working" });

		const follow = await handleFetch(call(`/api/sessions/${ID}/messages`, "POST", { text: "Ще й CHANGELOG" }), env, agent);
		expect(follow.status).toBe(200);
		expect(sessions.get(ID)?.messages).toEqual(["Поправ README", "Ще й CHANGELOG"]);

		expect((await handleFetch(call(`/api/sessions/${ID}/abort`, "POST"), env, agent)).status).toBe(200);
		expect(await (await handleFetch(call(`/api/sessions/${ID}`), env, agent)).json()).toEqual({ status: "idle" });

		await handleFetch(call(`/api/sessions/${ID}/messages`, "POST", { text: "Продовжуй" }), env, agent);
		expect(await (await handleFetch(call(`/api/sessions/${ID}`), env, agent)).json()).toEqual({ status: "working" });
	});

	it("повторне створення з тим самим id не дублює сесію", async () => {
		const { agent, sessions } = fakeAgent();
		const first = await handleFetch(call("/api/sessions", "POST", { prompt: "Перша", id: ID }), env, agent);
		const again = await handleFetch(call("/api/sessions", "POST", { prompt: "Друга", id: ID }), env, agent);
		expect(await again.json()).toEqual(await first.json());
		expect(sessions.size).toBe(1);
		expect(sessions.get(ID)?.messages).toEqual(["Перша"]);
	});

	it("DELETE /api/sessions/<id> видаляє сесію", async () => {
		const { agent, sessions } = fakeAgent();
		await agent.start(ID, { prompt: "x" });
		expect((await handleFetch(call(`/api/sessions/${ID}`, "DELETE"), env, agent)).status).toBe(200);
		expect(sessions.has(ID)).toBe(false);
	});

	it("статус невідомої сесії — stopped", async () => {
		const { agent } = fakeAgent();
		expect(await (await handleFetch(call("/api/sessions/session-9999"), env, agent)).json()).toEqual({ status: "stopped" });
	});

	it("без id у запиті створюється сесія з випадковим id", async () => {
		const { agent, sessions } = fakeAgent();
		const res = await handleFetch(call("/api/sessions", "POST", { prompt: "Задача" }), env, agent);
		const { id, url } = await res.json<{ id: string; url: string }>();
		expect(sessions.has(id)).toBe(true);
		expect(url).toBe(`https://agent.example/s/${id}`);
	});
});

describe("перевірка входу", () => {
	it("відхиляє порожній промпт і текст, погані id та repo", async () => {
		const { agent, sessions } = fakeAgent();
		expect((await handleFetch(call("/api/sessions", "POST", { prompt: "  " }), env, agent)).status).toBe(400);
		expect((await handleFetch(call("/api/sessions", "POST", { prompt: "x", id: "BAD ID" }), env, agent)).status).toBe(400);
		expect((await handleFetch(call("/api/sessions", "POST", { prompt: "x", repo: "../etc" }), env, agent)).status).toBe(400);
		expect((await handleFetch(call(`/api/sessions/${ID}/messages`, "POST", { text: " " }), env, agent)).status).toBe(400);
		expect((await handleFetch(call("/api/sessions/BAD", "GET"), env, agent)).status).toBe(400);
		expect(sessions.size).toBe(0);
	});

	it("невідомий метод або дія — 404", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call(`/api/sessions/${ID}/abort`, "GET"), env, agent)).status).toBe(404);
	});
});

describe("веб-інтерфейс", () => {
	// Ключ сервера в маршруті інтерфейсу: base64url адреси сервера без «=».
	const key = btoa("https://agent.example").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

	it("/s/<id> веде прямо на сторінку цієї сесії в інтерфейсі, без cookie й очищення браузера", async () => {
		const { agent } = fakeAgent();
		await agent.start(ID, { prompt: "Задача" });
		const link = await handleFetch(call(`/s/${ID}`), env, agent);
		expect(link.status).toBe(302);
		expect(link.headers.get("location")).toBe(`/server/${key}/session/ses_${ID}`);
		expect(link.headers.get("set-cookie")).toBeNull();
		expect(link.headers.get("clear-site-data")).toBeNull();
	});

	it("/s/<id> невідомої сесії — 404, поганого id — 400", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call(`/s/${ID}`), env, agent)).status).toBe(404);
		expect((await handleFetch(call("/s/BAD"), env, agent)).status).toBe(400);
	});

	it("решту запитів проксує в спільний інтерфейс без жодної cookie вибору сесії", async () => {
		const { agent, served } = fakeAgent();
		expect(await (await handleFetch(call("/"), env, agent)).text()).toBe("ui");
		expect(await (await handleFetch(call("/api/session?limit=10"), env, agent)).text()).toBe("ui");
		expect(served).toEqual(["/", "/api/session"]);
	});

	it("/sw.js віддає нейтральний service worker без кешування (не з контейнера)", async () => {
		const { agent, served } = fakeAgent();
		const res = await handleFetch(call("/sw.js"), env, agent);
		expect(res.headers.get("content-type")).toBe("text/javascript");
		expect(await res.text()).not.toContain("fetch");
		expect(served).toEqual([]);
	});
});

describe("ручний знімок", () => {
	it("GET /api/computer/connections повертає SSH-з'єднання", async () => {
		const { agent } = fakeAgent();
		const res = await handleFetch(call("/api/computer/connections?detail=1", "GET"), env, agent);
		expect(await res.json()).toMatchObject({ running: true, ssh: { listening: true, connections: 1 } });
	});

	it("GET /api/computer повертає стан контейнера", async () => {
		const { agent } = fakeAgent();
		const res = await handleFetch(call("/api/computer", "GET"), env, agent);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ running: true, streams: [] });
	});

	it("DELETE /api/computer/snapshot скидає комп'ютер, GET — ні", async () => {
		const { agent, resets } = fakeAgent();
		expect((await handleFetch(call("/api/computer/snapshot", "DELETE"), env, agent)).status).toBe(200);
		expect(resets).toHaveLength(1);
	});

	it("POST /api/computer/snapshot зберігає диск і повертає знімок", async () => {
		const { agent, snapshots } = fakeAgent();
		const res = await handleFetch(call("/api/computer/snapshot", "POST"), env, agent);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: "snap1", bytes: 1, ms: 2 });
		expect(snapshots).toHaveLength(1);
	});

	it("зайнятий агент чи сплячий контейнер — 409 з причиною", async () => {
		const { agent, failSnapshot } = fakeAgent();
		failSnapshot("an agent is busy");
		const res = await handleFetch(call("/api/computer/snapshot", "POST"), env, agent);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "an agent is busy" });
	});

	it("лише POST, інші методи йдуть у проксі й знімка не роблять", async () => {
		const { agent, snapshots } = fakeAgent();
		await handleFetch(call("/api/computer/snapshot", "GET"), env, agent);
		expect(snapshots).toHaveLength(0);
	});
});

describe("вхід у Сільпо", () => {
	it("/silpo/login редіректить на Сільпо з адресою повернення на цей воркер", async () => {
		const { agent } = fakeAgent();
		const res = await handleFetch(call("/silpo/login"), env, agent);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("redirect_uri=https://agent.example/silpo/callback");
	});

	it("/silpo/callback з правильним state підключає Сільпо, з хибним чи без коду — 400", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call("/silpo/callback?code=c1&state=good"), env, agent)).status).toBe(200);
		expect(await agent.silpoConnected()).toBe(true);
		expect((await handleFetch(call("/silpo/callback?code=c2&state=bad"), env, agent)).status).toBe(400);
		expect((await handleFetch(call("/silpo/callback"), env, agent)).status).toBe(400);
	});

	it("вхід лише за Access", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call("/silpo/login"), accessEnv, agent)).status).toBe(503);
	});
});

describe("вхід у Google Calendar", () => {
	it("/calendar/login редіректить на Google з адресою повернення на цей воркер", async () => {
		const { agent } = fakeAgent();
		const res = await handleFetch(call("/calendar/login"), env, agent);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("redirect_uri=https://agent.example/calendar/callback");
	});

	it("без GOOGLE_CLIENT_ID/SECRET вхід дає 503, а не виняток", async () => {
		const { agent } = fakeAgent();
		agent.calendarLoginUrl = async () => {
			throw new Error("calendar: не налаштовано");
		};
		expect((await handleFetch(call("/calendar/login"), env, agent)).status).toBe(503);
	});

	it("/calendar/callback з правильним state підключає Календар, з хибним чи без коду — 400", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call("/calendar/callback?code=c1&state=good"), env, agent)).status).toBe(200);
		expect(await agent.calendarConnected()).toBe(true);
		expect((await handleFetch(call("/calendar/callback?code=c2&state=bad"), env, agent)).status).toBe(400);
		expect((await handleFetch(call("/calendar/callback"), env, agent)).status).toBe(400);
	});

	it("вхід лише за Access", async () => {
		const { agent } = fakeAgent();
		expect((await handleFetch(call("/calendar/login"), accessEnv, agent)).status).toBe(503);
	});
});

describe("розклади автоматизацій", () => {
	const SID = "abcdef12";
	const fakeSchedules = () => {
		const calls: string[] = [];
		const schedule = { id: SID, name: "n", prompt: "p", when: { at: 1 }, status: "active", createdBy: "owner", createdAt: 1, origin: "https://agent.example", runs: [{ at: 1, result: "ok" }] };
		const schedules = {
			list: async () => [schedule],
			get: async (id: string) => (id === SID ? schedule : undefined),
			create: async (input: { name: string }, by: string, origin: string) => (calls.push(`create ${input.name} ${by} ${origin}`), input.name === "bad" ? { ok: false, error: "nope", code: "invalid" } : { ok: true, value: schedule }),
			update: async (id: string, patch: object) => (calls.push(`update ${id} ${JSON.stringify(patch)}`), { ok: true, value: schedule }),
			pause: async (id: string) => (calls.push(`pause ${id}`), { ok: true, value: schedule }),
			resume: async (id: string) => (calls.push(`resume ${id}`), { ok: false, error: "limit", code: "limit" }),
			runNow: async (id: string) => (calls.push(`run ${id}`), { ok: true, value: { at: 2, result: "ok" } }),
			remove: async (id: string) => (calls.push(`remove ${id}`), id === SID),
		};
		return { calls, schedules: schedules as unknown as import("../src/domain/schedule").Schedules };
	};

	it("список, створення (від власника, з адресою воркера), читання, зміна, дії, історія, видалення", async () => {
		const { agent } = fakeAgent();
		const { calls, schedules } = fakeSchedules();
		const h = (path: string, method = "GET", body?: unknown) => handleFetch(call(path, method, body), env, agent, schedules);

		expect((await (await h("/api/schedules")).json() as { schedules: unknown[] }).schedules).toHaveLength(1);
		expect((await h("/api/schedules", "POST", { name: "ok", prompt: "x", cron: "0 9 * * *" })).status).toBe(200);
		expect(calls).toContain("create ok owner https://agent.example");
		const bad = await h("/api/schedules", "POST", { name: "bad" });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "nope" });

		expect((await h(`/api/schedules/${SID}`)).status).toBe(200);
		expect((await h("/api/schedules/00000000")).status).toBe(404);
		expect((await h("/api/schedules/xx")).status).toBe(400);
		expect((await h(`/api/schedules/${SID}`, "PATCH", { prompt: "y" })).status).toBe(200);
		expect(calls).toContain(`update ${SID} {"prompt":"y"}`);
		expect((await h(`/api/schedules/${SID}/pause`, "POST")).status).toBe(200);
		expect((await h(`/api/schedules/${SID}/resume`, "POST")).status).toBe(409);
		expect(await (await h(`/api/schedules/${SID}/run`, "POST")).json()).toEqual({ run: { at: 2, result: "ok" } });
		expect(await (await h(`/api/schedules/${SID}/runs`)).json()).toEqual({ runs: [{ at: 1, result: "ok" }] });
		expect((await h(`/api/schedules/${SID}/pause`)).status).toBe(405);
		expect((await h(`/api/schedules/${SID}`, "DELETE")).status).toBe(200);
		expect((await h("/api/schedules/00000000", "DELETE")).status).toBe(404);
	});

	it("за Access, як і решта API", async () => {
		const { agent } = fakeAgent();
		const { schedules } = fakeSchedules();
		const configured = { ...accessEnv, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" } as Env;
		expect((await handleFetch(call("/api/schedules"), configured, agent, schedules)).status).toBe(403);
	});
});

describe("веб-сторінка автоматизацій", () => {
	const schedules = {} as import("../src/domain/schedule").Schedules;

	it("віддається за Access лише з розкладами; скрипт синтаксично коректний і не вставляє дані через innerHTML", async () => {
		const { agent } = fakeAgent();
		const res = await handleFetch(call("/automations"), env, agent, schedules);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("Автоматизації агента");
		expect(html).not.toContain("innerHTML");
		const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
		expect(() => new Function(script)).not.toThrow();
		const configured = { ...accessEnv, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" } as Env;
		expect((await handleFetch(call("/automations"), configured, agent, schedules)).status).toBe(403);
	});

	it("попередній перегляд: найближчі запуски й помилки валідації", async () => {
		const { agent } = fakeAgent();
		const post = (body: unknown) => handleFetch(call("/api/schedules/preview", "POST", body), env, agent, schedules);
		const ok = await post({ cron: "0 9 * * *", tz: "UTC" });
		const { times } = (await ok.json()) as { times: number[] };
		expect(times).toHaveLength(5);
		expect(times.every((t, i) => i === 0 || t - times[i - 1] === 86_400_000)).toBe(true);
		const bad = await post({ cron: "*/5 * * * *" });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toContain("1 hour");
		expect((await post({ at: "2020-01-01T00:00:00Z" })).status).toBe(400);
		expect((await handleFetch(call("/api/schedules/preview"), env, agent, schedules)).status).toBe(405);
	});
});

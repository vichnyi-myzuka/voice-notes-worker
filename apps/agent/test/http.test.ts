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

describe("веб-інтерфейс сесії", () => {
	it("/s/<id> ставить cookie й веде у веб-інтерфейс, а далі запити йдуть у ту саму сесію", async () => {
		const { agent, served } = fakeAgent();
		const link = await handleFetch(call(`/s/${ID}`), env, agent);
		expect(link.status).toBe(200);
		expect(await link.text()).toContain('location.replace("/")');
		expect(link.headers.get("clear-site-data")).toBe('"storage"'); // нова сесія: стан браузера від попередньої застарів
		const cookie = link.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`agent_session=${ID}`);
		expect(cookie).toMatch(/HttpOnly/);
		expect(cookie).toMatch(/Secure/);

		const page = await handleFetch(call("/", "GET", undefined, { cookie: `x=1; agent_session=${ID}` }), env, agent);
		expect(await page.text()).toBe(`ui:${ID}`);
		expect(served).toEqual([ID]);
	});

	it("/s/<id> тієї самої сесії не чистить стан браузера", async () => {
		const { agent } = fakeAgent();
		const link = await handleFetch(call(`/s/${ID}`, "GET", undefined, { cookie: `agent_session=${ID}` }), env, agent);
		expect(link.headers.get("clear-site-data")).toBeNull();
	});

	it("/sw.js віддає нейтральний service worker без кешування (не з контейнера)", async () => {
		const { agent, served } = fakeAgent();
		const res = await handleFetch(call("/sw.js"), env, agent);
		expect(res.headers.get("content-type")).toBe("text/javascript");
		expect(await res.text()).not.toContain("fetch");
		expect(served).toEqual([]);
	});

	it("без cookie сесії або з поганою проксі не працює", async () => {
		const { agent, served } = fakeAgent();
		expect((await handleFetch(call("/"), env, agent)).status).toBe(404);
		expect((await handleFetch(call("/", "GET", undefined, { cookie: "agent_session=../x" }), env, agent)).status).toBe(404);
		expect(served).toEqual([]);
	});
});

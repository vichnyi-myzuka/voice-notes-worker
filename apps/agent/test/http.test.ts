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

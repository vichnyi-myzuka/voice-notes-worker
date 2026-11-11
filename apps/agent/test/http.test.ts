import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleFetch } from "../src/interface/http";

// LOCAL_DEV вимикає Access; перевірку токена окремо покриває access.test.ts.
function envWith(stub: { start?: ReturnType<typeof vi.fn>; fetch?: ReturnType<typeof vi.fn> } = {}, extra: Partial<Env> = {}) {
	const names: string[] = [];
	const env = {
		LOCAL_DEV: "1",
		OPENCODE_SERVER_PASSWORD: "pw",
		AGENT_SESSION: { getByName: (name: string) => (names.push(name), { start: stub.start ?? vi.fn(), fetch: stub.fetch ?? vi.fn(async () => new Response("ui")) }) },
		...extra,
	} as unknown as Env;
	return { env, names };
}

const post = (body: unknown) => new Request("https://agent.example/api/sessions", { method: "POST", body: JSON.stringify(body) });

describe("handleFetch", () => {
	it("без налаштованого Access відповідає 503, з чужим токеном — 403", async () => {
		const { env } = envWith({}, { LOCAL_DEV: undefined });
		expect((await handleFetch(new Request("https://agent.example/"), env)).status).toBe(503);
		const configured = envWith({}, { LOCAL_DEV: undefined, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" }).env;
		expect((await handleFetch(new Request("https://agent.example/"), configured)).status).toBe(403);
	});

	it("POST /api/sessions стартує сесію й повертає посилання", async () => {
		const start = vi.fn(async () => ({ sessionId: "oc1" }));
		const { env, names } = envWith({ start });
		const res = await handleFetch(post({ prompt: "Поправ README", repo: "me/app", id: "session-0001" }), env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: "session-0001", url: "https://agent.example/s/session-0001" });
		expect(names).toEqual(["session-0001"]);
		expect(start).toHaveBeenCalledWith({ prompt: "Поправ README", repo: "me/app" });
	});

	it("відхиляє порожній промпт, погані id і repo", async () => {
		const { env } = envWith();
		expect((await handleFetch(post({ prompt: "  " }), env)).status).toBe(400);
		expect((await handleFetch(post({ prompt: "x", id: "BAD ID" }), env)).status).toBe(400);
		expect((await handleFetch(post({ prompt: "x", repo: "../etc" }), env)).status).toBe(400);
	});

	it("/s/<id> ставить cookie й веде у веб-інтерфейс, а далі запити йдуть у ту саму сесію", async () => {
		const fetchStub = vi.fn(async () => new Response("ui"));
		const { env, names } = envWith({ fetch: fetchStub });
		const link = await handleFetch(new Request("https://agent.example/s/session-0001"), env);
		expect(link.status).toBe(302);
		expect(link.headers.get("location")).toBe("/");
		const cookie = link.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("agent_session=session-0001");
		expect(cookie).toMatch(/HttpOnly/);
		expect(cookie).toMatch(/Secure/);

		const page = await handleFetch(new Request("https://agent.example/", { headers: { cookie: "x=1; agent_session=session-0001" } }), env);
		expect(await page.text()).toBe("ui");
		expect(names).toEqual(["session-0001"]);
	});

	it("без cookie сесії проксі не працює", async () => {
		const { env } = envWith();
		expect((await handleFetch(new Request("https://agent.example/"), env)).status).toBe(404);
		expect((await handleFetch(new Request("https://agent.example/", { headers: { cookie: "agent_session=../x" } }), env)).status).toBe(404);
	});
});

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

describe("воркер", () => {
	const env = (extra: Partial<Env> = {}) => ({ ASSETS: { fetch: async () => new Response("<h1>x</h1>", { headers: { "content-type": "text/html" } }) }, ...extra }) as unknown as Env;

	it("без налаштованого Access відповідає 503, з невірним JWT — 403", async () => {
		expect((await worker.fetch(new Request("https://d.example/"), env())).status).toBe(503);
		expect((await worker.fetch(new Request("https://d.example/"), env({ ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "a" }))).status).toBe(403);
	});

	it("локально віддає статику із захисними заголовками, лише GET", async () => {
		const res = await worker.fetch(new Request("https://d.example/"), env({ LOCAL_DEV: "1" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-robots-tag")).toBe("noindex");
		expect((await worker.fetch(new Request("https://d.example/", { method: "POST" }), env({ LOCAL_DEV: "1" }))).status).toBe(405);
	});
});

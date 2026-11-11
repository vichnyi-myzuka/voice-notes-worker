import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { serveSite, siteKey } from "../src/serve";

// R2 у пам'яті: get і list з delimiter (лише те, що використовує воркер).
function fakeSites(files: Record<string, string>) {
	const SITES = {
		get: async (key: string) => (key in files ? { body: new Response(files[key]).body, httpEtag: '"e1"', httpMetadata: {} } : null),
		list: async () => ({ delimitedPrefixes: [...new Set(Object.keys(files).map((k) => `${k.split("/")[0]}/`))] }),
	};
	return { SITES } as unknown as Env;
}

const get = (env: Env, path: string, method = "GET") => serveSite(new Request(`https://sites.example${path}`, { method }), env);

describe("шлях → ключ в R2", () => {
	it("теки віддають index.html, файли — як є", () => {
		expect(siteKey("/demo/")).toEqual({ name: "demo", key: "demo/index.html" });
		expect(siteKey("/demo/a/b.js")).toEqual({ name: "demo", key: "demo/a/b.js" });
		expect(siteKey("/demo/docs/")).toEqual({ name: "demo", key: "demo/docs/index.html" });
		expect(siteKey("/demo")).toEqual({ redirect: "/demo/" });
	});

	it("небезпечні й чужі шляхи відхиляються", () => {
		for (const path of ["/demo/../secret", "/demo/%2e%2e/x", "/demo/a//b", "/demo/a%5Cb", "/demo/%00", "/Demo/x", "/-x/y", "/a/y", "//x/y", "/demo/%zz"]) {
			expect(siteKey(path), path).toBeNull();
		}
	});
});

describe("віддача сайту", () => {
	const env = fakeSites({ "demo/index.html": "<h1>hi</h1>", "demo/app.js": "1", "demo/data.bin": "x", "other/index.html": "o" });

	it("index.html для кореня сайту, правильний content-type і захисні заголовки", async () => {
		const res = await get(env, "/demo/");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<h1>hi</h1>");
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("etag")).toBe('"e1"');
		expect((await get(env, "/demo/app.js")).headers.get("content-type")).toContain("javascript");
		expect((await get(env, "/demo/data.bin")).headers.get("content-type")).toBe("application/octet-stream");
	});

	it("/demo без слеша → 308 на /demo/; відсутній файл і чужа назва → 404", async () => {
		const redirect = await get(env, "/demo");
		expect([redirect.status, redirect.headers.get("location")]).toEqual([308, "https://sites.example/demo/"]);
		expect((await get(env, "/demo/missing.html")).status).toBe(404);
		expect((await get(env, "/nope/")).status).toBe(404);
	});

	it("HEAD без тіла, інші методи — 405", async () => {
		const head = await get(env, "/demo/", "HEAD");
		expect([head.status, await head.text()]).toEqual([200, ""]);
		expect((await get(env, "/demo/", "POST")).status).toBe(405);
	});

	it("корінь показує список сайтів; назви екрануються", async () => {
		const html = await (await get(env, "/")).text();
		expect(html).toContain('<a href="/demo/">demo</a>');
		expect(html).toContain('<a href="/other/">other</a>');
		const weird = fakeSites({ "<script>/x": "1", "ok/index.html": "1" });
		const list = await (await get(weird, "/")).text();
		expect(list).not.toContain("<script>");
		expect(list).toContain("ok");
		expect(await (await get(fakeSites({}), "/")).text()).toContain("Поки порожньо");
	});
});

describe("захист", () => {
	it("без налаштованого Access — 503, з чужим токеном — 403, у LOCAL_DEV пропускає", async () => {
		const env = fakeSites({ "demo/index.html": "x" });
		const call = (e: Env) => worker.fetch(new Request("https://sites.example/demo/"), e);
		expect((await call(env)).status).toBe(503);
		expect((await call({ ...env, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" })).status).toBe(403);
		expect((await call({ ...env, LOCAL_DEV: "1" })).status).toBe(200);
	});
});

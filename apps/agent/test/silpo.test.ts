import { afterEach, describe, expect, it, vi } from "vitest";
import { silpoLogin } from "../src/infrastructure/container/logins";

function memory() {
	const store = new Map<string, unknown>();
	return { store, storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v) } as never };
}

// Сільпо у пам'яті: реєстрація клієнта й токен-ендпоінт; усі виклики записуються.
function fakeSilpo(tokenReply: () => Response) {
	const calls: { url: string; body: string }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls.push({ url, body: String(init.body) });
		return url.endsWith("/register") ? Response.json({ client_id: "cid" }) : tokenReply();
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Silpo (OAuth для MCP)", () => {
	it("вхід: реєструє клієнта, дає адресу з PKCE; повернення з чужим state відхиляється, зі своїм — зберігає токени", async () => {
		const calls = fakeSilpo(() => Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }));
		const { storage } = memory();
		const silpo = silpoLogin(storage);
		const url = new URL(await silpo.loginUrl("https://agent.example"));
		expect(url.origin + url.pathname).toBe("https://mcp.silpo.ua/authorize");
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("redirect_uri")).toBe("https://agent.example/silpo/callback");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(JSON.parse(calls[0].body)).toMatchObject({ redirect_uris: ["https://agent.example/silpo/callback"], token_endpoint_auth_method: "none" });

		expect(await silpo.callback("code", "wrong")).toBe(false);
		expect(await silpo.connected()).toBe(false);
		expect(await silpo.callback("code", url.searchParams.get("state")!)).toBe(true);
		const exchange = new URLSearchParams(calls[1].body);
		expect(exchange.get("grant_type")).toBe("authorization_code");
		expect(exchange.get("code_verifier")).toBeTruthy();
		expect(await silpo.accessToken()).toMatchObject({ access: "acc" });
		expect(await silpo.callback("code", url.searchParams.get("state")!)).toBe(false); // state одноразовий
	});

	it("клієнта не реєструє повторно, поки адреса воркера та сама", async () => {
		const calls = fakeSilpo(() => Response.json({}));
		const silpo = silpoLogin(memory().storage);
		await silpo.loginUrl("https://agent.example");
		await silpo.loginUrl("https://agent.example");
		expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
		await silpo.loginUrl("https://other.example");
		expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(2);
	});

	it("токен, що скоро спливе, оновлює через refresh_token і зберігає новий; без входу чи при збої refresh — undefined", async () => {
		let reply = () => Response.json({ access_token: "acc1", refresh_token: "ref1", expires_in: 60 });
		const calls = fakeSilpo(() => reply());
		const silpo = silpoLogin(memory().storage);
		expect(await silpo.accessToken()).toBeUndefined();
		const state = new URL(await silpo.loginUrl("https://agent.example")).searchParams.get("state")!;
		await silpo.callback("c", state); // expires_in 60 с: уже в межах запасу

		reply = () => Response.json({ access_token: "acc2", expires_in: 3600 }); // refresh_token не ротується
		expect(await silpo.accessToken()).toMatchObject({ access: "acc2" });
		expect(new URLSearchParams(calls.at(-1)!.body).get("refresh_token")).toBe("ref1");
		expect(await silpo.accessToken()).toMatchObject({ access: "acc2" }); // свіжий: без нового запиту
		expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
	});

	it("збій refresh дає undefined, а не виняток", async () => {
		let reply = () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 1 });
		fakeSilpo(() => reply());
		const silpo = silpoLogin(memory().storage);
		await silpo.callback("c", new URL(await silpo.loginUrl("https://agent.example")).searchParams.get("state")!);
		reply = () => new Response("no", { status: 400 });
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await silpo.accessToken()).toBeUndefined();
	});
});

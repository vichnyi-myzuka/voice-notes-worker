import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareLogin } from "../src/infrastructure/container/logins";

function memory() {
	const store = new Map<string, unknown>();
	return { store, storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v) } as never };
}

function fakeCloudflare() {
	const calls: { url: string; body: string }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls.push({ url, body: String(init.body) });
		return url.endsWith("/register") ? Response.json({ client_id: "cid" }) : Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare (OAuth для MCP)", () => {
	it("реєструє клієнта, веде на mcp.cloudflare.com з PKCE і правами лише на читання, обмінює код на токен", async () => {
		const calls = fakeCloudflare();
		const login = cloudflareLogin(memory().storage);
		const url = new URL(await login.loginUrl("https://agent.example"));
		expect(url.origin + url.pathname).toBe("https://mcp.cloudflare.com/authorize");
		expect(url.searchParams.get("redirect_uri")).toBe("https://agent.example/cloudflare/callback");
		expect(url.searchParams.get("scope")).toBe("offline_access user:read account:read");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(calls[0].url).toBe("https://mcp.cloudflare.com/register");
		expect(await login.callback("code", "wrong")).toBe(false);
		expect(await login.callback("code", url.searchParams.get("state")!)).toBe(true);
		expect(calls[1].url).toBe("https://mcp.cloudflare.com/token");
		expect(await login.accessToken()).toMatchObject({ access: "acc" });
	});

	it("права можна розширити через CLOUDFLARE_MCP_SCOPE", async () => {
		fakeCloudflare();
		const login = cloudflareLogin(memory().storage, "offline_access user:read workers-scripts.write");
		expect(new URL(await login.loginUrl("https://agent.example")).searchParams.get("scope")).toBe("offline_access user:read workers-scripts.write");
	});
});

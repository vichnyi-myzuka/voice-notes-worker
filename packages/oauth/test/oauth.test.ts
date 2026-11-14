import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthLogin } from "../src";

const store = () => {
	const map = new Map<string, unknown>();
	return { map, storage: { get: async (k: string) => map.get(k), put: async (k: string, v: unknown) => void map.set(k, v) } as never };
};

const provider = { name: "svc", key: "svc", authUrl: "https://svc.example/auth", tokenUrl: "https://svc.example/token", callbackPath: "/svc/callback", client: { id: "cid", secret: "sec" } };

afterEach(() => vi.unstubAllGlobals());

describe("OAuthLogin", () => {
	it("додає scope й додаткові параметри в адресу входу та шле client secret при обміні коду", async () => {
		const bodies: URLSearchParams[] = [];
		vi.stubGlobal("fetch", async (_: string, init: RequestInit) => (bodies.push(new URLSearchParams(String(init.body))), Response.json({ access_token: "a", expires_in: 3600 })));
		const login = new OAuthLogin(store().storage, { ...provider, scope: "s1 s2", authParams: { prompt: "consent" } });
		const url = new URL(await login.loginUrl("https://agent.example"));
		expect(url.searchParams.get("scope")).toBe("s1 s2");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(await login.callback("code", url.searchParams.get("state")!)).toBe(true);
		expect(bodies[0].get("client_secret")).toBe("sec");
		expect(bodies[0].get("redirect_uri")).toBe("https://agent.example/svc/callback");
	});

	it("читає стан, збережений до рефакторингу (pending без redirect, адреса повернення в client)", async () => {
		const { map, storage } = store();
		map.set("svc", { client: { id: "cid", redirect: "https://agent.example/svc/callback" }, pending: { state: "st", verifier: "v" } });
		const bodies: URLSearchParams[] = [];
		vi.stubGlobal("fetch", async (_: string, init: RequestInit) => (bodies.push(new URLSearchParams(String(init.body))), Response.json({ access_token: "a" })));
		const login = new OAuthLogin(storage, { ...provider, client: undefined, register: { url: "https://svc.example/register", clientName: "Agent" } });
		expect(await login.callback("code", "st")).toBe(true);
		expect(bodies[0].get("redirect_uri")).toBe("https://agent.example/svc/callback");
		expect(bodies[0].get("client_id")).toBe("cid");
	});
});

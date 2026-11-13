import { afterEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "../src/infrastructure/container/calendar";

function memory() {
	const store = new Map<string, unknown>();
	return { store, storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v) } as never };
}

// Токен-ендпоінт Google у пам'яті; усі виклики записуються.
function fakeGoogle(reply: () => Response) {
	const calls: { url: string; body: URLSearchParams }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls.push({ url, body: new URLSearchParams(String(init.body)) });
		return reply();
	});
	return calls;
}

const CLIENT = { id: "gid", secret: "gsecret" };

afterEach(() => vi.unstubAllGlobals());

describe("Calendar (OAuth для MCP Google Calendar)", () => {
	it("вхід: адреса з PKCE, offline-доступом і правами на події; чужий state відхиляється, свій — зберігає токени", async () => {
		const calls = fakeGoogle(() => Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }));
		const cal = new Calendar(memory().storage, CLIENT);
		const url = new URL(await cal.loginUrl("https://agent.example"));
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(url.searchParams.get("client_id")).toBe("gid");
		expect(url.searchParams.get("redirect_uri")).toBe("https://agent.example/calendar/callback");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");

		expect(await cal.callback("code", "wrong")).toBe(false);
		expect(await cal.connected()).toBe(false);
		expect(await cal.callback("code", url.searchParams.get("state")!)).toBe(true);
		expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
		expect(calls[0].body.get("grant_type")).toBe("authorization_code");
		expect(calls[0].body.get("client_secret")).toBe("gsecret");
		expect(calls[0].body.get("code_verifier")).toBeTruthy();
		expect(await cal.accessToken()).toBe("acc");
		expect(await cal.callback("code", url.searchParams.get("state")!)).toBe(false); // state одноразовий
	});

	it("без client id/secret вхід неможливий", async () => {
		await expect(new Calendar(memory().storage, {}).loginUrl("https://agent.example")).rejects.toThrow(/GOOGLE_CLIENT_ID/);
	});

	it("токен, що скоро спливе, оновлює через refresh_token (Google його не ротує) і не робить зайвих запитів", async () => {
		let reply = () => Response.json({ access_token: "acc1", refresh_token: "ref1", expires_in: 60 });
		const calls = fakeGoogle(() => reply());
		const cal = new Calendar(memory().storage, CLIENT);
		expect(await cal.accessToken()).toBeUndefined();
		await cal.callback("c", new URL(await cal.loginUrl("https://agent.example")).searchParams.get("state")!); // expires_in 60 с: уже в межах запасу

		reply = () => Response.json({ access_token: "acc2", expires_in: 3600 });
		expect(await cal.accessToken()).toBe("acc2");
		expect(calls.at(-1)!.body.get("refresh_token")).toBe("ref1");
		expect(await cal.accessToken()).toBe("acc2");
		expect(calls).toHaveLength(2);
	});

	it("збій refresh дає undefined, а не виняток", async () => {
		let reply = () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 1 });
		fakeGoogle(() => reply());
		const cal = new Calendar(memory().storage, CLIENT);
		await cal.callback("c", new URL(await cal.loginUrl("https://agent.example")).searchParams.get("state")!);
		reply = () => new Response("no", { status: 400 });
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await cal.accessToken()).toBeUndefined();
	});
});

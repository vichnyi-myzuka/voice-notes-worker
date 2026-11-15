import { afterEach, describe, expect, it, vi } from "vitest";
import type { Llm } from "@voice-notes/core";
import type { Env } from "../src/env";
import { handleTelegram } from "../src/interface/telegram";
import { MANAGED_PATH, handleManagedBotCreated, handleManagedWebhook, sendNewBotLink } from "../src/interface/managed-bots";
import { fakeAgent } from "./fake-agent";

vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

const env = { BOT_TOKEN: "manager", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42" } as unknown as Env;
const CHILD = 777;

// Telegram на підміненому fetch: запам'ятовує виклики (з токеном бота в адресі).
function setup() {
	const calls: { token: string; method: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const [, token, method] = /\/bot([^/]+)\/(\w+)/.exec(input)!;
			calls.push({ token, method, body: JSON.parse(init!.body as string) });
			const result = method === "getMe" ? { id: 1, username: "mgr_bot", has_topics_enabled: token === "child-token" } : method === "getManagedBotToken" ? "child-token" : method === "sendMessage" ? { message_id: 1 } : true;
			return Response.json({ ok: true, result });
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("керовані боти (PoC)", () => {
	it("/newbot шле кнопку-посилання t.me/newbot/<менеджер>/<юзернейм>", async () => {
		const calls = setup();
		await sendNewBotLink({ BOT_TOKEN: "manager" }, 42);
		const keyboard = calls.find((c) => c.method === "sendMessage")!.body.reply_markup as { inline_keyboard: { url: string }[][] };
		expect(keyboard.inline_keyboard[0][0].url).toMatch(/^https:\/\/t\.me\/newbot\/mgr_bot\/agent_\w+_bot\?name=/);
	});

	it("managed_bot від власника: токен у менеджера, вебхук дитини, повідомлення власнику", async () => {
		const calls = setup();
		await handleManagedBotCreated({ BOT_TOKEN: "manager" }, env, { user: { id: 42 }, bot: { id: CHILD, username: "x_bot" } }, "https://agent.example");
		expect(calls.map((c) => `${c.token}:${c.method}`)).toEqual(["manager:getManagedBotToken", "child-token:setWebhook", "child-token:getMe", "manager:sendMessage"]);
		expect(String(calls[3].body.text)).toContain("теми в приваті: ✅");
		expect(calls[1].body).toMatchObject({ url: `https://agent.example${MANAGED_PATH}${CHILD}`, allowed_updates: ["message"] });
	});

	it("managed_bot не від власника ігнорується", async () => {
		const calls = setup();
		await handleManagedBotCreated({ BOT_TOKEN: "manager" }, env, { user: { id: 99 }, bot: { id: CHILD } }, "https://agent.example");
		expect(calls).toEqual([]);
	});

	it("основний вебхук передає managed_bot обробнику", async () => {
		const created = vi.fn(async () => {});
		const pending: Promise<unknown>[] = [];
		const managed = { user: { id: 42 }, bot: { id: CHILD } };
		const res = await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ update_id: 1, managed_bot: managed }) }), env, { agent: fakeAgent().agent, llm: {} as Llm, defer: (w) => void pending.push(w), managed: { newBot: async () => {}, created } });
		await Promise.all(pending);
		expect(res.status).toBe(200);
		expect(created).toHaveBeenCalledWith({ BOT_TOKEN: "manager" }, managed, "https://agent.example");
	});

	it("вебхук дитини: без правильного секрету 401, від власника — луна, від чужого — тиша", async () => {
		const calls = setup();
		// секрет, який виставив handleManagedBotCreated
		await handleManagedBotCreated({ BOT_TOKEN: "manager" }, env, { user: { id: 42 }, bot: { id: CHILD } }, "https://agent.example");
		const secret = (calls.find((c) => c.method === "setWebhook")!.body as { secret_token: string }).secret_token;
		calls.length = 0;
		const pending: Promise<unknown>[] = [];
		const post = (from: number, token = secret) => handleManagedWebhook(new Request(`https://agent.example${MANAGED_PATH}${CHILD}`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": token }, body: JSON.stringify({ message: { message_id: 1, chat: { id: from, type: "private" }, from: { id: from }, text: "привіт" } }) }), env, (w) => void pending.push(w));
		expect((await post(42, "bad")).status).toBe(401);
		await post(99);
		await post(42);
		await Promise.all(pending);
		expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
		expect(String(calls.find((c) => c.method === "sendMessage")!.body.text)).toContain("теми в приваті");
		expect(calls.find((c) => c.method === "sendMessage")).toMatchObject({ token: "child-token", body: { chat_id: 42, text: expect.stringContaining("привіт") } });
	});
});

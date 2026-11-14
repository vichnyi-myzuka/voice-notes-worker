import { describe, expect, it, vi } from "vitest";
import type { Schedule, Schedules } from "../src/domain/schedule";
import type { Env } from "../src/env";
import { handleAgentApi } from "../src/interface/http";
import { parseCallback, callback } from "../src/infrastructure/chat";
import { sessionToken } from "../src/infrastructure/session-token";

// timingSafeEqual є лише в workerd: у Node мокаємо порівняння (мок за шляхом файлу в core).
vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

const env = { OPENCODE_PASSWORD: "pw" } as unknown as Env;
const FOLDER = "daily-report-abc123";
const SID = "abcdef12";

function setup() {
	const calls: string[] = [];
	const schedule = { id: SID, name: "n" } as Schedule;
	const schedules = {
		list: async () => [schedule],
		create: async (input: { name: string }, by: string, origin: string) => (calls.push(`create ${input.name} ${by} ${origin}`), { ok: true, value: schedule }),
		update: async (id: string, patch: object, by?: string) => (calls.push(`update ${id} ${JSON.stringify(patch)} ${by}`), { ok: true, value: schedule }),
		remove: async (id: string) => (calls.push(`remove ${id}`), id === SID),
	} as unknown as Schedules;
	const call = async (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) => {
		const auth = { authorization: `Bearer ${await sessionToken("pw", FOLDER)}`, "x-session-folder": FOLDER };
		return handleAgentApi(new Request(`https://agent.example/agent-api/schedules${path}`, { method, headers: headers ?? auth, ...(body !== undefined && { body: JSON.stringify(body) }) }), env, schedules);
	};
	return { calls, call };
}

describe("API розкладів для агента", () => {
	it("токен залежить від теки сесії й ключа", async () => {
		expect(await sessionToken("pw", FOLDER)).toMatch(/^[0-9a-f]{64}$/);
		expect(await sessionToken("pw", FOLDER)).toBe(await sessionToken("pw", FOLDER));
		expect(await sessionToken("pw", "other")).not.toBe(await sessionToken("pw", FOLDER));
		expect(await sessionToken("pw2", FOLDER)).not.toBe(await sessionToken("pw", FOLDER));
	});

	it("без токена, з чужим токеном чи чужою текою — 401", async () => {
		const { call } = setup();
		expect((await call("", "GET", undefined, {})).status).toBe(401);
		expect((await call("", "GET", undefined, { authorization: "Bearer nope", "x-session-folder": FOLDER })).status).toBe(401);
		expect((await call("", "GET", undefined, { authorization: `Bearer ${await sessionToken("pw", FOLDER)}`, "x-session-folder": "other" })).status).toBe(401);
		expect((await call("", "GET", undefined, { authorization: `Bearer ${await sessionToken("pw", "../x")}`, "x-session-folder": "../x" })).status).toBe(401);
	});

	it("список, створення (від агента), зміна (від агента), видалення", async () => {
		const { call, calls } = setup();
		expect((await call("")).status).toBe(200);
		expect((await call("", "POST", { name: "r", prompt: "p", cron: "0 9 * * *" })).status).toBe(200);
		expect(calls).toContain("create r agent https://agent.example");
		expect((await call(`/${SID}`, "PATCH", { prompt: "q" })).status).toBe(200);
		expect(calls).toContain(`update ${SID} {"prompt":"q"} agent`);
		expect((await call(`/${SID}`, "DELETE")).status).toBe(200);
		expect((await call("/00000000", "DELETE")).status).toBe(404);
		expect((await call("/xx", "DELETE")).status).toBe(400);
		expect((await call(`/${SID}/run`, "POST")).status).toBe(400); // агент не запускає й не вмикає розклади
		expect((await call("", "DELETE")).status).toBe(405);
	});
});

describe("кнопки підтвердження розкладу", () => {
	it("формат callback_data розбирається назад", () => {
		expect(parseCallback(callback.schedule("ok", SID))).toEqual({ kind: "schedule", approve: true, id: SID });
		expect(parseCallback(callback.schedule("no", SID))).toEqual({ kind: "schedule", approve: false, id: SID });
		expect(parseCallback("sch:ok:zzz")).toBeUndefined();
		expect(callback.schedule("ok", SID).length).toBeLessThan(64);
	});
});

describe("натискання кнопок підтвердження в Telegram", () => {
	const tgEnv = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42", CHAT_ID: "-1001" } as unknown as Env;
	async function press(data: string, status: Schedule["status"] = "pending") {
		const sent: { method: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => (sent.push({ method: input.split("/").pop()!, body: JSON.parse(init!.body as string) }), Response.json({ ok: true, result: true }))));
		const calls: string[] = [];
		const s = { id: SID, name: "Звіт", status, when: { cron: "0 9 * * *", tz: "Europe/Kyiv" }, nextRun: Date.parse("2026-11-15T07:00:00Z") } as Schedule;
		const schedules = { get: async () => s, remove: async (id: string) => (calls.push(`remove ${id}`), true), resume: async (id: string) => (calls.push(`resume ${id}`), { ok: true, value: s }) } as unknown as Schedules;
		const { handleTelegram } = await import("../src/interface/telegram");
		const { fakeAgent } = await import("./fake-agent");
		const pending: Promise<unknown>[] = [];
		const query = { id: "cb", from: { id: 42 }, message: { message_id: 100, chat: { id: 42, type: "private" } }, data };
		await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ update_id: 1, callback_query: query }) }), tgEnv, { agent: fakeAgent().agent, llm: {} as never, schedules, defer: (w) => void pending.push(w) });
		await Promise.all(pending);
		vi.unstubAllGlobals();
		return { calls, sent };
	}

	it("✅ активує й показує перший запуск, ❌ видаляє", async () => {
		const ok = await press(callback.schedule("ok", SID));
		expect(ok.calls).toEqual([`resume ${SID}`]);
		expect(ok.sent.find((c) => c.method === "editMessageText")?.body.text).toContain("Активовано: «Звіт»");
		const no = await press(callback.schedule("no", SID));
		expect(no.calls).toEqual([`remove ${SID}`]);
		expect(no.sent.find((c) => c.method === "editMessageText")?.body.text).toContain("Відхилено");
	});

	it("уже оброблений розклад не чіпається", async () => {
		const r = await press(callback.schedule("ok", SID), "active");
		expect(r.calls).toEqual([]);
		expect(r.sent.find((c) => c.method === "answerCallbackQuery")?.body.text).toContain("неактуально");
	});
});

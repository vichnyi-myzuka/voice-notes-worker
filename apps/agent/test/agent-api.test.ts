import { describe, expect, it, vi } from "vitest";
import type { Schedule, Schedules } from "../src/domain/schedule";
import type { Env } from "../src/env";
import { handleAgentApi } from "../src/interface/http";
import { callback, parseCallback, scheduleCard, scheduleHistory } from "../src/infrastructure/chat";
import { sessionToken } from "../src/infrastructure/session-token";

// timingSafeEqual є лише в workerd: у Node мокаємо порівняння (мок за шляхом файлу в core).
vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

// LOCAL_DEV вимикає перевірку Access: її окремо покриває тест нижче (і access.test.ts у core).
const env = { OPENCODE_PASSWORD: "pw", LOCAL_DEV: "1" } as unknown as Env;
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

	it("шлях за Access: без налаштованого Access — 503, без JWT — 403, навіть із правильним секретом сесії", async () => {
		const schedules = { list: async () => [] } as unknown as Schedules;
		const headers = { authorization: `Bearer ${await sessionToken("pw", FOLDER)}`, "x-session-folder": FOLDER };
		const req = () => new Request("https://agent.example/agent-api/schedules", { headers });
		expect((await handleAgentApi(req(), { OPENCODE_PASSWORD: "pw" } as unknown as Env, schedules)).status).toBe(503);
		const configured = { OPENCODE_PASSWORD: "pw", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" } as unknown as Env;
		expect((await handleAgentApi(req(), configured, schedules)).status).toBe(403);
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

describe("кнопки автоматизацій", () => {
	it("формат callback_data розбирається назад", () => {
		for (const action of ["ok", "no", "pause", "resume", "run", "hist", "del"] as const) expect(parseCallback(callback.schedule(action, SID))).toEqual({ kind: "schedule", action, id: SID });
		expect(parseCallback("sch:ok:zzz")).toBeUndefined();
		expect(parseCallback("sch:boom:abcdef12")).toBeUndefined();
		expect(callback.schedule("resume", SID).length).toBeLessThan(64);
	});

	it("картка: кнопки залежать від стану, історія з посиланнями на сесії", () => {
		const base = { id: SID, name: "Звіт", prompt: "Зроби звіт", when: { cron: "0 9 * * *", tz: "Europe/Kyiv" }, createdBy: "owner", createdAt: 1, origin: "https://agent.example", runs: [], nextRun: Date.parse("2026-11-15T07:00:00Z") } as unknown as Schedule;
		const labels = (s: Schedule) => scheduleCard(s).reply_markup.inline_keyboard.flat().map((b) => b.text);
		expect(labels({ ...base, status: "pending" })).toEqual(["✅ Активувати", "❌ Відхилити"]);
		expect(labels({ ...base, status: "active" })).toEqual(["⏸ Пауза", "▶️ Запустити зараз", "📜 Історія", "🗑 Видалити"]);
		expect(labels({ ...base, status: "paused" })[0]).toBe("▶️ Увімкнути");
		const card = scheduleCard({ ...base, status: "active", runs: [{ at: 1, result: "failed", error: "boom" }] }).text;
		expect(card).toContain("🟢 активна");
		expect(card).toContain("0 9 * * * (Europe/Kyiv)");
		expect(card).toContain("Наступний запуск:");
		expect(card).toContain("❌ не вдалося");
		expect(scheduleHistory({ ...base, status: "active", runs: [{ at: 1, result: "ok", sessionId: "tg-sch-x" }] })).toContain("https://agent.example/s/tg-sch-x");
		expect(scheduleHistory({ ...base, status: "active" })).toContain("запусків ще не було");
	});
});

describe("Telegram: автоматизації", () => {
	const tgEnv = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42", CHAT_ID: "-1001" } as unknown as Env;
	const sched = (status: Schedule["status"]) => ({ id: SID, name: "Звіт", prompt: "p", status, origin: "https://agent.example", when: { cron: "0 9 * * *", tz: "Europe/Kyiv" }, runs: [], createdBy: "agent", createdAt: 1, nextRun: Date.parse("2026-11-15T07:00:00Z") }) as Schedule;

	// Один вебхук (кнопка чи повідомлення) з фейковим розкладом; повертає виклики Telegram і розкладу.
	async function hook(update: Record<string, unknown>, status: Schedule["status"] = "pending", all: Schedule[] | undefined = undefined, runResult: "ok" | "skipped" = "ok") {
		const sent: { method: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => (sent.push({ method: input.split("/").pop()!, body: JSON.parse(init!.body as string) }), Response.json({ ok: true, result: { message_id: 1 } }))));
		const calls: string[] = [];
		let s = sched(status);
		const schedules = {
			list: async () => all ?? [s],
			get: async () => s,
			remove: async (id: string) => (calls.push(`remove ${id}`), true),
			resume: async (id: string) => (calls.push(`resume ${id}`), (s = { ...s, status: "active" }), { ok: true, value: s }),
			pause: async (id: string) => (calls.push(`pause ${id}`), (s = { ...s, status: "paused" }), { ok: true, value: s }),
			runNow: async (id: string) => (calls.push(`run ${id}`), { ok: true, value: { at: 1, result: runResult } }),
		} as unknown as Schedules;
		const { handleTelegram } = await import("../src/interface/telegram");
		const { fakeAgent } = await import("./fake-agent");
		const pending: Promise<unknown>[] = [];
		await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ update_id: 1, ...update }) }), tgEnv, { agent: fakeAgent().agent, llm: {} as never, schedules, defer: (w) => void pending.push(w), sleep: async () => {} });
		await Promise.all(pending);
		vi.unstubAllGlobals();
		return { calls, sent, edited: sent.find((c) => c.method === "editMessageText")?.body, answered: sent.find((c) => c.method === "answerCallbackQuery")?.body.text };
	}
	const press = (action: Parameters<typeof callback.schedule>[0], status?: Schedule["status"], runResult?: "ok" | "skipped") =>
		hook({ callback_query: { id: "cb", from: { id: 42 }, message: { message_id: 100, chat: { id: 42, type: "private" } }, data: callback.schedule(action, SID) } }, status, undefined, runResult);

	it("✅ активує й оновлює картку, ❌ видаляє", async () => {
		const ok = await press("ok");
		expect(ok.calls).toEqual([`resume ${SID}`]);
		expect(ok.edited?.text).toContain("🟢 активна");
		const no = await press("no");
		expect(no.calls).toEqual([`remove ${SID}`]);
		expect(no.edited?.text).toContain("Відхилено");
	});

	it("уже оброблений розклад не підтверджується вдруге", async () => {
		const r = await press("ok", "active");
		expect(r.calls).toEqual([]);
		expect(r.answered).toContain("неактуально");
	});

	it("пауза, увімкнення, запуск зараз, історія, видалення", async () => {
		const pause = await press("pause", "active");
		expect(pause.calls).toEqual([`pause ${SID}`]);
		expect(pause.edited?.text).toContain("⏸ на паузі");
		expect((await press("resume", "paused")).calls).toEqual([`resume ${SID}`]);
		const run = await press("run", "active");
		expect(run.calls).toEqual([`run ${SID}`]);
		expect(run.answered).toBe("Запускаю.");
		expect((await press("run", "active", "skipped")).answered).toContain("ще працює");
		const hist = await press("hist", "active");
		expect(hist.sent.find((c) => c.method === "sendMessage")?.body.text).toContain("запусків ще не було");
		const del = await press("del", "active");
		expect(del.calls).toEqual([`remove ${SID}`]);
		expect(del.sent.some((c) => c.method === "deleteMessage")).toBe(true);
	});

	it("/automations показує по картці на розклад, без розкладів — підказку; команда з чату прибирається", async () => {
		const message = { message_id: 7, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/automations" };
		const some = await hook({ message }, "active");
		const card = some.sent.find((c) => c.method === "sendMessage")!.body;
		expect(String(card.text)).toContain("⏰ Звіт");
		expect(JSON.stringify(card.reply_markup)).toContain(`sch:pause:${SID}`);
		expect(some.sent.some((c) => c.method === "deleteMessage" && c.body.message_id === 7)).toBe(true);
		const none = await hook({ message }, "active", []);
		expect(String(none.sent.find((c) => c.method === "sendMessage")!.body.text)).toContain("Автоматизацій ще немає");
	});
});

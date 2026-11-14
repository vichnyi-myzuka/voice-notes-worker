import { describe, expect, it } from "vitest";
import { nextCron, parseCron } from "../src/domain/schedule/cron";
import { validate, MAX_ACTIVE } from "../src/domain/schedule";
import type { Schedule } from "../src/domain/schedule";
import { ScheduleBook, runSessionId, type Launcher } from "../src/infrastructure/scheduler/book";

const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());
const next = (expr: string, tz: string, after: string) => iso(nextCron(parseCron(expr), tz, Date.parse(after)));

describe("cron", () => {
	it("щодня о 09:00 за київським часом (зима й літо мають різний зсув)", () => {
		expect(next("0 9 * * *", "Europe/Kyiv", "2026-01-10T00:00:00Z")).toBe("2026-01-10T07:00:00.000Z");
		expect(next("0 9 * * *", "Europe/Kyiv", "2026-07-10T00:00:00Z")).toBe("2026-07-10T06:00:00.000Z");
	});
	it("запуск строго після моменту відліку", () => {
		expect(next("0 9 * * *", "UTC", "2026-01-10T09:00:00Z")).toBe("2026-01-11T09:00:00.000Z");
	});
	it("кроки, діапазони й списки", () => {
		expect(next("*/15 * * * *", "UTC", "2026-01-10T09:01:00Z")).toBe("2026-01-10T09:15:00.000Z");
		expect(next("30 8-10 * * 1,3", "UTC", "2026-01-10T00:00:00Z")).toBe("2026-01-12T08:30:00.000Z"); // 10.01.2026 — субота
	});
	it("день-тижня: 7 — неділя; день місяця й день тижня діють як «або»", () => {
		expect(next("0 12 * * 7", "UTC", "2026-01-10T00:00:00Z")).toBe("2026-01-11T12:00:00.000Z");
		expect(next("0 12 15 * 1", "UTC", "2026-01-10T00:00:00Z")).toBe("2026-01-12T12:00:00.000Z");
	});
	it("не пропускає запуск після перескоку на літній час", () => {
		// 29.03.2026 о 03:00 Київ переходить на літній час; 00:30 наступної доби має знайтися
		expect(next("30 0 30 3 *", "Europe/Kyiv", "2026-03-28T12:00:00Z")).toBe("2026-03-29T21:30:00.000Z");
	});
	it("неможливий день повертає undefined", () => {
		expect(nextCron(parseCron("0 0 30 2 *"), "UTC", 0)).toBeUndefined();
	});
	it("відхиляє некоректні вирази", () => {
		for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"]) expect(() => parseCron(bad), bad).toThrow();
	});
});

const NOW = Date.parse("2026-11-14T10:00:00Z");
const base = { name: "Ранковий звіт", prompt: "Зроби звіт" };

describe("validate", () => {
	it("одноразовий запуск у майбутньому", () => {
		const r = validate({ ...base, at: "2026-11-15T09:00:00+02:00" }, NOW);
		expect(r).toMatchObject({ ok: true, value: { when: { at: Date.parse("2026-11-15T07:00:00Z") } } });
	});
	it("минуле, поганий формат, обидва чи жодного способу — помилка", () => {
		expect(validate({ ...base, at: "2026-11-13T09:00:00Z" }, NOW)).toMatchObject({ ok: false, code: "invalid" });
		expect(validate({ ...base, at: "завтра" }, NOW).ok).toBe(false);
		expect(validate({ ...base, at: "2026-11-15T09:00:00Z", cron: "0 9 * * *" }, NOW).ok).toBe(false);
		expect(validate(base, NOW).ok).toBe(false);
	});
	it("cron: часовий пояс за замовчуванням Київ, інтервал не менший за годину", () => {
		expect(validate({ ...base, cron: "0 9 * * *" }, NOW)).toMatchObject({ ok: true, value: { when: { cron: "0 9 * * *", tz: "Europe/Kyiv" } } });
		expect(validate({ ...base, cron: "*/30 * * * *" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("1 hour") });
		expect(validate({ ...base, cron: "0 */1 * * *" }, NOW).ok).toBe(true);
		expect(validate({ ...base, cron: "0 9 * * *", tz: "Mars/Base" }, NOW).ok).toBe(false);
	});
	it("назва, prompt, репозиторій, термін дії", () => {
		expect(validate({ ...base, name: " ", cron: "0 9 * * *" }, NOW).ok).toBe(false);
		expect(validate({ ...base, prompt: "", cron: "0 9 * * *" }, NOW).ok).toBe(false);
		expect(validate({ ...base, repo: "oops", cron: "0 9 * * *" }, NOW).ok).toBe(false);
		expect(validate({ ...base, cron: "0 9 * * *", expiresAt: "2026-01-01T00:00:00Z" }, NOW).ok).toBe(false);
	});
});

// Книга розкладів на пам'яті з керованим часом і фейковим запуском.
function setup(budget = 0) {
	const data = new Map<string, unknown>();
	const clock = { now: NOW };
	const alarm = { at: null as number | null };
	const launched: { id: string; session: string }[] = [];
	const notes: string[] = [];
	const proposed: string[] = [];
	const spentIds: string[][] = [];
	const state = { running: new Set<string>(), failLaunch: false, costs: {} as Record<string, number> };
	const launcher: Launcher = {
		async launch(s, session) {
			if (state.failLaunch) throw new Error("boom");
			launched.push({ id: s.id, session });
		},
		async running(session) {
			return state.running.has(session);
		},
		async propose(s) {
			proposed.push(s.id);
		},
		async spent(ids) {
			spentIds.push(ids);
			return ids.reduce((sum, id) => sum + (state.costs[id] ?? 0), 0);
		},
		async notify(text) {
			notes.push(text);
		},
	};
	const store = {
		get: async <T>(k: string) => data.get(k) as T | undefined,
		put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
		delete: async (k: string) => data.delete(k),
		list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
	};
	const book = new ScheduleBook(store, { set: async (at) => void (alarm.at = at), clear: async () => void (alarm.at = null) }, launcher, () => clock.now, budget);
	const make = async (input: Parameters<ScheduleBook["create"]>[0], by: Schedule["createdBy"] = "owner") => {
		const r = await book.create(input, by, "https://agent.example");
		if (!r.ok) throw new Error(r.error);
		return r.value;
	};
	return { book, clock, alarm, launched, notes, proposed, spentIds, state, make };
}

describe("ScheduleBook", () => {
	it("ліміт вартості запуску: перевіряється, зберігається, знімається нулем", async () => {
		expect(validate({ ...base, cron: "0 9 * * *", maxCostUsd: 2.5 }, NOW)).toMatchObject({ ok: true, value: { maxCostUsd: 2.5 } });
		expect(validate({ ...base, cron: "0 9 * * *", maxCostUsd: 0 }, NOW)).toMatchObject({ ok: true });
		for (const bad of [-1, 101, Number.NaN]) expect(validate({ ...base, cron: "0 9 * * *", maxCostUsd: bad }, NOW).ok, String(bad)).toBe(false);
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC", maxCostUsd: 3 });
		expect(s.maxCostUsd).toBe(3);
		expect((await t.book.update(s.id, { prompt: "x" }))).toMatchObject({ ok: true, value: { maxCostUsd: 3 } });
		await t.book.update(s.id, { maxCostUsd: 0 });
		expect((await t.book.get(s.id))!.maxCostUsd).toBeUndefined();
	});

	it("розклад від власника активний і ставить alarm на перший запуск; від агента чекає підтвердження", async () => {
		const t = setup();
		const mine = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		expect(mine).toMatchObject({ status: "active", createdBy: "owner", nextRun: Date.parse("2026-11-15T09:00:00Z") });
		expect(t.alarm.at).toBe(mine.nextRun);

		const theirs = await t.make({ ...base, name: "Від агента", cron: "0 8 * * *", tz: "UTC" }, "agent");
		expect(theirs.status).toBe("pending");
		expect(t.alarm.at).toBe(mine.nextRun); // pending alarm не ставить
		expect(t.proposed).toEqual([theirs.id]); // власнику показано пропозицію з кнопками (розклад власника — ні)

		const resumed = await t.book.resume(theirs.id);
		expect(resumed).toMatchObject({ ok: true, value: { status: "active" } });
		expect(t.alarm.at).toBe(Date.parse("2026-11-15T08:00:00Z"));
	});

	it("alarm запускає сесію з детермінованим id, переносить cron на наступний раз і пише історію", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		t.clock.now = s.nextRun! + 1000;
		await t.book.tick();
		expect(t.launched).toEqual([{ id: s.id, session: runSessionId(s.id, s.nextRun!) }]);
		const after = (await t.book.get(s.id))!;
		expect(after.runs).toEqual([{ at: s.nextRun, result: "ok", sessionId: runSessionId(s.id, s.nextRun!) }]);
		expect(after.nextRun).toBe(Date.parse("2026-11-16T09:00:00Z"));
		expect(t.alarm.at).toBe(after.nextRun);
	});

	it("одноразовий розклад після запуску стає done, alarm знімається", async () => {
		const t = setup();
		const s = await t.make({ ...base, at: "2026-11-14T12:00:00Z" });
		t.clock.now = Date.parse("2026-11-14T12:00:05Z");
		await t.book.tick();
		expect(await t.book.get(s.id)).toMatchObject({ status: "done", runs: [{ result: "ok" }] });
		expect(t.alarm.at).toBeNull();
		expect(t.launched).toHaveLength(1);
		await t.book.tick();
		expect(t.launched).toHaveLength(1);
	});

	it("якщо попередній запуск ще працює, новий пропускається з повідомленням", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		t.clock.now = s.nextRun!;
		await t.book.tick();
		t.state.running.add(runSessionId(s.id, s.nextRun!));
		t.clock.now = Date.parse("2026-11-16T09:00:00Z");
		await t.book.tick();
		expect(t.launched).toHaveLength(1);
		expect((await t.book.get(s.id))!.runs.map((r) => r.result)).toEqual(["ok", "skipped"]);
		expect(t.notes[0]).toContain("пропущено");
		// наступного разу, коли сесія завершилась, запуск іде
		t.state.running.clear();
		t.clock.now = Date.parse("2026-11-17T09:00:00Z");
		await t.book.tick();
		expect(t.launched).toHaveLength(2);
	});

	it("збій запуску записується як failed і повідомляється, розклад живе далі", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		t.state.failLaunch = true;
		t.clock.now = s.nextRun!;
		await t.book.tick();
		const after = (await t.book.get(s.id))!;
		expect(after).toMatchObject({ status: "active", runs: [{ result: "failed", error: "boom" }] });
		expect(after.nextRun).toBe(Date.parse("2026-11-16T09:00:00Z"));
		expect(t.notes[0]).toContain("boom");
	});

	it("пауза знімає запуски, відновлення рахує наступний від поточного часу", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		expect(await t.book.pause(s.id)).toMatchObject({ ok: true, value: { status: "paused" } });
		expect(t.alarm.at).toBeNull();
		t.clock.now = Date.parse("2026-11-20T10:00:00Z");
		await t.book.tick();
		expect(t.launched).toHaveLength(0);
		const r = await t.book.resume(s.id);
		expect(r).toMatchObject({ ok: true, value: { nextRun: Date.parse("2026-11-21T09:00:00Z") } });
		expect((await t.book.pause("nope0000")).ok).toBe(false);
	});

	it("останній запуск до кінця терміну дії завершує розклад; прострочений не запускається", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC", expiresAt: "2026-11-16T12:00:00Z" });
		t.clock.now = s.nextRun!; // 15.11 о 09:00: наступний запуск (16.11) ще до кінця терміну
		await t.book.tick();
		expect(await t.book.get(s.id)).toMatchObject({ status: "active", nextRun: Date.parse("2026-11-16T09:00:00Z") });
		t.clock.now = Date.parse("2026-11-16T09:00:00Z"); // останній: наступний (17.11) уже після терміну
		await t.book.tick();
		expect(t.launched).toHaveLength(2);
		expect(await t.book.get(s.id)).toMatchObject({ status: "done" });

		const late = await t.make({ ...base, name: "late", cron: "0 9 * * *", tz: "UTC", expiresAt: "2026-11-16T12:00:00Z" });
		t.clock.now = Date.parse("2026-11-17T10:00:00Z"); // alarm прийшов після терміну дії
		await t.book.tick();
		expect(t.launched).toHaveLength(2);
		expect((await t.book.get(late.id))!.status).toBe("done");
	});

	it("не більше 10 активних розкладів", async () => {
		const t = setup();
		for (let i = 0; i < MAX_ACTIVE; i++) await t.make({ ...base, name: `n${i}`, cron: "0 9 * * *", tz: "UTC" });
		expect(await t.book.create({ ...base, cron: "0 9 * * *" }, "owner", "https://agent.example")).toMatchObject({ ok: false, code: "limit" });
		const [first] = await t.book.list();
		await t.book.pause(first.id); // пауза звільняє місце
		expect((await t.book.create({ ...base, cron: "0 9 * * *" }, "owner", "https://agent.example")).ok).toBe(true);
		expect(await t.book.resume(first.id)).toMatchObject({ ok: false, code: "limit" });
	});

	it("зміна полів і часу; змінена зараз одноразова дата в минулому відхиляється", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		expect(await t.book.update(s.id, { prompt: "Новий prompt" })).toMatchObject({ ok: true, value: { prompt: "Новий prompt", nextRun: s.nextRun, when: { cron: "0 9 * * *" } } });
		expect(await t.book.update(s.id, { cron: "0 18 * * *" })).toMatchObject({ ok: true, value: { nextRun: Date.parse("2026-11-14T18:00:00Z"), when: { cron: "0 18 * * *", tz: "UTC" } } });
		expect(await t.book.update(s.id, { tz: "Europe/Kyiv" })).toMatchObject({ ok: true, value: { when: { cron: "0 18 * * *", tz: "Europe/Kyiv" } } });
		expect(await t.book.update(s.id, { at: "2020-01-01T00:00:00Z" })).toMatchObject({ ok: false, code: "invalid" });
		expect(await t.book.update(s.id, { cron: "* * * * *" })).toMatchObject({ ok: false, code: "invalid" });
		expect(await t.book.update("nope0000", { name: "x" })).toMatchObject({ ok: false, code: "not_found" });
	});

	it("зміна від агента повертає розклад на підтвердження й показує пропозицію знову; зміна власника — ні", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		expect(await t.book.update(s.id, { prompt: "власник" })).toMatchObject({ ok: true, value: { status: "active" } });
		expect(t.proposed).toEqual([]);
		const r = await t.book.update(s.id, { prompt: "агент" }, "agent");
		expect(r).toMatchObject({ ok: true, value: { status: "pending", prompt: "агент" } });
		expect(t.proposed).toEqual([s.id]);
		expect(t.alarm.at).toBeNull(); // до підтвердження не запускається
		t.clock.now = s.nextRun!;
		await t.book.tick();
		expect(t.launched).toHaveLength(0);
		expect(await t.book.resume(s.id)).toMatchObject({ ok: true, value: { status: "active" } });
	});

	it("збій показу пропозиції не скасовує розклад", async () => {
		const t = setup();
		const book = new ScheduleBook({ get: async () => undefined, put: async () => {}, delete: async () => true, list: async () => new Map() }, { set: async () => {}, clear: async () => {} }, { launch: async () => {}, running: async () => false, notify: async () => {}, propose: async () => { throw new Error("tg down"); }, spent: async () => 0 }, () => NOW);
		expect(await book.create({ ...base, cron: "0 9 * * *" }, "agent", "https://agent.example")).toMatchObject({ ok: true, value: { status: "pending" } });
		expect(t.proposed).toEqual([]);
	});

	it("порожні repo, model і expiresAt знімають значення (форма на вебі)", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC", repo: "me/app", model: "opus", expiresAt: "2027-01-01T00:00:00Z" });
		const r = await t.book.update(s.id, { repo: "", model: "", expiresAt: "" });
		expect(r.ok && r.value).toMatchObject({ name: base.name });
		expect(r.ok && Object.keys(r.value)).not.toEqual(expect.arrayContaining(["repo"]));
		const saved = (await t.book.get(s.id))!;
		expect(saved.repo).toBeUndefined();
		expect(saved.model).toBeUndefined();
		expect(saved.expiresAt).toBeUndefined();
	});

	it("добовий бюджет: вичерпаний — запуск пропускається з причиною, «запустити зараз» бюджет ігнорує, за добу витрати спадають", async () => {
		const t = setup(5);
		const a = await t.make({ ...base, name: "a", cron: "0 9 * * *", tz: "UTC" });
		const b = await t.make({ ...base, name: "b", cron: "0 10 * * *", tz: "UTC" });
		t.clock.now = Date.parse("2026-11-15T09:00:00Z");
		await t.book.tick(); // a: бюджет цілий
		const first = runSessionId(a.id, Date.parse("2026-11-15T09:00:00Z"));
		expect(t.launched.map((l) => l.session)).toEqual([first]);
		t.state.costs[first] = 5.5; // перший запуск перевищив добовий бюджет
		t.clock.now = Date.parse("2026-11-15T10:00:00Z");
		await t.book.tick(); // b: пропущено
		expect(t.launched).toHaveLength(1);
		const skipped = (await t.book.get(b.id))!.runs[0];
		expect(skipped).toMatchObject({ result: "skipped", error: expect.stringContaining("бюджет $5") });
		expect(t.notes.at(-1)).toContain("пропущено");
		expect(t.spentIds.at(-1)).toEqual([first]);
		expect(await t.book.runNow(b.id)).toMatchObject({ ok: true, value: { result: "ok" } }); // ручний запуск іде
		t.clock.now = Date.parse("2026-11-16T10:00:01Z"); // минула доба від першого запуску
		await t.book.tick();
		expect((await t.book.get(a.id))!.runs.at(-1)!.result).toBe("ok");
		expect(t.spentIds.at(-1)).not.toContain(first);
	});

	it("без бюджету (0) витрати не перевіряються", async () => {
		const t = setup(0);
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		t.clock.now = s.nextRun!;
		await t.book.tick();
		expect(t.spentIds).toEqual([]);
		expect(t.launched).toHaveLength(1);
	});

	it("«запустити зараз» не чіпає розкладу; видалення прибирає запис і alarm", async () => {
		const t = setup();
		const s = await t.make({ ...base, cron: "0 9 * * *", tz: "UTC" });
		const r = await t.book.runNow(s.id);
		expect(r).toMatchObject({ ok: true, value: { result: "ok", sessionId: runSessionId(s.id, NOW) } });
		expect(await t.book.get(s.id)).toMatchObject({ nextRun: s.nextRun, runs: [{ result: "ok" }] });
		expect(await t.book.remove(s.id)).toBe(true);
		expect(await t.book.remove(s.id)).toBe(false);
		expect(t.alarm.at).toBeNull();
	});
});

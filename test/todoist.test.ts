import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOps, planOps, withAppliedRecurrence, type ApplyParams } from "../src/application/tasks";
import { formatTriage } from "../src/domain/note";

import type { TaskOp, TrackedTasks, TrackerSnapshot, TriageItem } from "../src/domain/tracker";
import { r2Ledger } from "../src/infrastructure/r2";
import { buildCommands, RULES_PROJECT, todoistTracker } from "../src/infrastructure/todoist";
import { fetchSnapshot, findRulesProject } from "../src/infrastructure/todoist/api";
import { taskRulesBlock, taskValidator } from "../src/infrastructure/todoist/fields";
import type { Json } from "../src/domain/json";
import type { Env } from "../src/infrastructure/env";
import { fakeEnv } from "./fake-env";

// Параметри запуску, які в тестах задаються до виклику applyPrepared (id запуску — з префіксом команд).
const taskPorts = (env: Env) => ({ tracker: todoistTracker(env), ledger: r2Ledger(env) });
const prepared = new Map<string, ApplyParams>();
async function prepare(_env: unknown, ops: TaskOp[], description: string, noteId: string): Promise<string> {
	const runId = crypto.randomUUID();
	prepared.set(runId, { noteId, runId, ops, description });
	return runId;
}
const applyPrepared = (env: Env, id: string) => applyOps(taskPorts(env), prepared.get(id)!);

const snap: TrackerSnapshot = {
	projects: [
		{ id: "inbox-id", name: "Inbox", inbox: true },
		{ id: "work-id", name: "Work", inbox: false },
		{ id: "home-id", name: "Home", inbox: false },
	],
	labels: ["Errand", "Home", "Waiting"],
	tasks: ["Купити молоко", "Подзвонити Іллі"],
	rules: "",
};

const item = (title: string, extra: Partial<TriageItem> = {}): TriageItem => ({
	title,
	duplicateOf: "",
	project: "",
	labels: [],
	priority: 4,
	due: "",
	deadline: "",
	...extra,
});

describe("taskValidator", () => {
	const base = new Date("2026-11-09T10:00:00Z");
	const validate = taskValidator(snap, base, "Europe/Kyiv");

	it("мітка, що збігається з назвою проєкту, відкидається; неіснуючі мітки й повтори теж", () => {
		const r = validate({ title: "Х", project: "Home", labels: ["Home", "Errand", "Errand", "Вигадана"] });
		expect(r.project).toBe("Home");
		expect(r.labels).toEqual(["Errand"]);
	});
	it("мітка Home лишається, якщо проєкт інший", () => {
		expect(validate({ title: "Х", project: "Work", labels: ["Home"] }).labels).toEqual(["Home"]);
	});
	it("невідомий проєкт → Inbox (порожній рядок); назва Inbox теж дає Inbox", () => {
		expect(validate({ title: "Х", project: "Нема" }).project).toBe("");
		expect(validate({ title: "Х", project: "Inbox" }).project).toBe("");
		expect(validate({ title: "Х" }).project).toBe("");
	});
	it("мітки не масив → порожній список", () => {
		expect(validate({ title: "Х", labels: "Errand" }).labels).toEqual([]);
	});
	it("пріоритет: p1→1, p3→3, сміття → 4", () => {
		expect(validate({ title: "Х", priority: "p1" }).priority).toBe(1);
		expect(validate({ title: "Х", priority: "p3" }).priority).toBe(3);
		expect(validate({ title: "Х", priority: "p9" }).priority).toBe(4);
		expect(validate({ title: "Х", priority: "p0" }).priority).toBe(4);
		expect(validate({ title: "Х", priority: "high" }).priority).toBe(4);
		expect(validate({ title: "Х" }).priority).toBe(4);
	});
	it("today/tomorrow рахуються відносно base у часовому поясі", () => {
		const r = validate({ title: "Х", due: "today", deadline: "tomorrow" });
		expect(r.due).toBe("2026-11-09");
		expect(r.deadline).toBe("2026-11-10");
	});
	it("через північ у Києві: 22:30 UTC 9-го — це вже 10-те", () => {
		const v = taskValidator(snap, new Date("2026-11-09T22:30:00Z"), "Europe/Kyiv");
		const r = v({ title: "Х", due: "today", deadline: "tomorrow" });
		expect(r.due).toBe("2026-11-10");
		expect(r.deadline).toBe("2026-11-11");
	});
	it("у UTC той самий момент ще 9-те", () => {
		const v = taskValidator(snap, new Date("2026-11-09T22:30:00Z"), "UTC");
		expect(v({ title: "Х", due: "today" }).due).toBe("2026-11-09");
	});
	it.each([
		// [момент UTC, сьогодні, завтра] — навколо переходів на зимовий і літній час у Києві
		["2026-10-24T20:30:00Z", "2026-10-24", "2026-10-25"], // 23:30 перед переходом на зимовий час
		["2026-10-24T21:30:00Z", "2026-10-25", "2026-10-26"], // 00:30 у ніч переходу: +24 год дало б 25-те
		["2026-10-25T21:30:00Z", "2026-10-25", "2026-10-26"],
		["2027-03-27T21:30:00Z", "2027-03-27", "2027-03-28"], // 23:30 перед переходом на літній час: +24 год дало б 29-те
		["2027-03-28T20:30:00Z", "2027-03-28", "2027-03-29"],
	])("перехід на інший час: %s → сьогодні %s, завтра %s (рівно наступний календарний день)", (at, today, tomorrow) => {
		const v = taskValidator(snap, new Date(at), "Europe/Kyiv");
		const r = v({ title: "Х", due: "today", deadline: "tomorrow" });
		expect(r.due).toBe(today);
		expect(r.deadline).toBe(tomorrow);
	});
	it("коректна дата лишається, некоректна → порожньо", () => {
		expect(validate({ title: "Х", due: "2026-12-01" }).due).toBe("2026-12-01");
		expect(validate({ title: "Х", due: "колись" }).due).toBe("");
		expect(validate({ title: "Х", deadline: "01.12.2026" }).deadline).toBe("");
		expect(validate({ title: "Х", due: 5 }).due).toBe("");
	});
	it("duplicate_of нормалізується до точної назви існуючої задачі", () => {
		expect(validate({ title: "Х", duplicate_of: "  купити   МОЛОКО " }).duplicateOf).toBe("Купити молоко");
		expect(validate({ title: "Х", duplicate_of: "Купити хліб" }).duplicateOf).toBe("");
		expect(validate({ title: "Х" }).duplicateOf).toBe("");
	});
	it("назва обрізається по краях", () => {
		expect(validate({ title: "  Х  " }).title).toBe("Х");
	});
	it("подробиці обрізаються по краях; без них — порожній рядок", () => {
		expect(validate({ title: "Х", details: "  Взяти паспорт  \n" }).details).toBe("Взяти паспорт");
		expect(validate({ title: "Х" }).details).toBe("");
	});
});

describe("taskValidator: нагадування", () => {
	const v = taskValidator(snap, new Date("2026-11-10T08:00:00Z"), "Europe/Kyiv");
	const rem = (reminders?: Json, due = "today 16:00") => v({ title: "Х", due, ...(reminders !== undefined && { reminders }) }).reminders;

	it("before N → before:N; абсолютні today/tomorrow/дата з часом → YYYY-MM-DDTHH:MM", () => {
		expect(rem(["before 60", "before:15", "before45"])).toEqual(["before:60", "before:15", "before:45"]);
		expect(rem(["today 9:00", "tomorrow 09:00", "2026-11-11 09:30", "2026-11-12T08:05"])).toEqual([
			"2026-11-10T09:00",
			"2026-11-11T09:00",
			"2026-11-11T09:30",
			"2026-11-12T08:05",
		]);
	});
	it("relative без часу в due відкидається; absolute працює і без due", () => {
		expect(rem(["before 60"], "2026-11-12")).toEqual([]);
		expect(rem(["before 60"], "")).toEqual([]);
		expect(rem(["before 60", "tomorrow 09:00"], "")).toEqual(["2026-11-11T09:00"]);
	});
	it("absolute лише з датою відкидається", () => {
		expect(rem(["tomorrow", "2026-11-12", "today"])).toEqual([]);
	});
	it("некоректні значення відкидаються", () => {
		expect(rem(["before 0", "before", "before -5", "before 99999", "колись", "", "today 25:00", 5, null])).toEqual([]);
		expect(rem("before 60")).toEqual([]);
		expect(rem(undefined)).toEqual([]);
	});
	it("дублікати після нормалізації прибираються", () => {
		expect(rem(["before 60", "before:60", "tomorrow 09:00", "2026-11-11T09:00"])).toEqual(["before:60", "2026-11-11T09:00"]);
	});
});

describe("planOps", () => {
	const prev = item("Старе", { key: "t1", project: "Work", labels: ["Errand"], priority: 2, due: "2026-11-10" });
	const inTodoist: TrackedTasks = { t1: { id: "100", item: prev }, t2: { id: "200", item: item("Видалене", { key: "t2" }) } };

	it("змінена задача оновлюється, прибрана видаляється", () => {
		const ops = planOps([{ ...prev, title: "Нове" }], inTodoist);
		expect(ops).toEqual([
			{ key: "t1", item: { ...prev, title: "Нове" }, id: "100" },
			{ key: "t2", item: null, id: "200" },
		]);
	});
	it("незмінена задача пропускається", () => {
		const ops = planOps([prev, item("Видалене", { key: "t2" })], inTodoist);
		expect(ops).toEqual([]);
	});
	it("нова задача створюється (без id)", () => {
		const ops = planOps([prev, item("Видалене", { key: "t2" }), item("Нова", { key: "t3" })], inTodoist);
		expect(ops).toEqual([{ key: "t3", item: item("Нова", { key: "t3" }) }]);
	});
	it("дублікати існуючих задач не створюються", () => {
		const ops = planOps([item("Молоко", { key: "t1", duplicateOf: "Купити молоко" })], {});
		expect(ops).toEqual([]);
	});
	it("move лише коли змінився проєкт", () => {
		const [same] = planOps([{ ...prev, priority: 1 }], { t1: inTodoist.t1 });
		expect(same.move).toBeUndefined();
		const [moved] = planOps([{ ...prev, project: "Home" }], { t1: inTodoist.t1 });
		expect(moved).toMatchObject({ id: "100", move: true });
		const [toInbox] = planOps([{ ...prev, project: "" }], { t1: inTodoist.t1 });
		expect(toInbox.move).toBe(true);
	});
	it("лише інший порядок міток — не зміна, операції немає", () => {
		const two = item("Два", { key: "t1", labels: ["Errand", "Waiting"] });
		const reordered = { ...two, labels: ["Waiting", "Errand"] };
		expect(planOps([reordered], { t1: { id: "100", item: two } })).toEqual([]);
	});
	it("зміна дедлайну, міток чи дати теж оновлює", () => {
		for (const change of [{ deadline: "2026-12-01" }, { labels: [] }, { due: "" }]) {
			expect(planOps([{ ...prev, ...change }], { t1: inTodoist.t1 })).toHaveLength(1);
		}
	});
});

describe("planOps: подробиці", () => {
	const prev = item("Задача", { key: "t1", priority: 2, details: "Старі" });
	const state: TrackedTasks = { t1: { id: "100", item: prev } };

	it("змінились лише подробиці → оновлення з describe:true", () => {
		const next = { ...prev, details: "Нові" };
		expect(planOps([next], state)).toEqual([{ key: "t1", item: next, id: "100", describe: true }]);
		const old = item("Задача", { key: "t1" });
		expect(planOps([{ ...old, details: "Додані" }], { t1: { id: "100", item: old } })[0].describe).toBe(true);
	});
	it("інша зміна без зміни подробиць → без describe", () => {
		const [op] = planOps([{ ...prev, priority: 1 }], state);
		expect(op.describe).toBeUndefined();
	});
	it("undefined і порожній рядок — те саме", () => {
		const old = item("Задача", { key: "t1" });
		expect(planOps([{ ...old, details: "" }], { t1: { id: "100", item: old } })).toEqual([]);
	});
});

describe("planOps: нагадування", () => {
	const prev = item("Зустріч", { key: "t1", due: "2026-11-11T16:00", reminders: ["before:60"] });
	const state: TrackedTasks = { t1: { id: "100", item: prev, reminderIds: ["r1"] } };

	it("змінені нагадування → op з reminders:true і oldReminderIds", () => {
		const next = { ...prev, reminders: ["2026-11-11T09:00"] };
		expect(planOps([next], state)).toEqual([{ key: "t1", item: next, id: "100", reminders: true, oldReminderIds: ["r1"] }]);
	});
	it("без збережених reminderIds → oldReminderIds порожній", () => {
		const next = { ...prev, reminders: [] };
		expect(planOps([next], { t1: { id: "100", item: prev } })).toEqual([{ key: "t1", item: next, id: "100", reminders: true, oldReminderIds: [] }]);
	});
	it("незмінені (навіть в іншому порядку) → без op", () => {
		const two = { ...prev, reminders: ["before:60", "before:10"] };
		expect(planOps([{ ...two, reminders: ["before:10", "before:60"] }], { t1: { id: "100", item: two } })).toEqual([]);
		expect(planOps([prev], state)).toEqual([]);
	});
	it("undefined і [] — те саме", () => {
		const old = item("А", { key: "t1" });
		expect(planOps([{ ...old, reminders: [] }], { t1: { id: "1", item: old } })).toEqual([]);
		expect(planOps([old], { t1: { id: "1", item: { ...old, reminders: [] } } })).toEqual([]);
	});
	it("інша зміна без нагадувань → op без reminders", () => {
		const [op] = planOps([{ ...prev, title: "Нова" }], state);
		expect(op.reminders).toBeUndefined();
		expect(op.oldReminderIds).toBeUndefined();
	});
	it("старий запис без reminders → додані нагадування дають reminders:true", () => {
		const old = item("А", { key: "t1", due: "2026-11-11T16:00" });
		const [op] = planOps([{ ...old, reminders: ["before:5"] }], { t1: { id: "1", item: old } });
		expect(op).toMatchObject({ reminders: true, oldReminderIds: [] });
	});
});

describe("buildCommands: нагадування", () => {
	it("створення: reminder_add після item_add, item_id = temp_id задачі", () => {
		const it1 = item("Зустріч", { key: "t1", due: "2026-11-11T16:00", reminders: ["before:60", "2026-11-11T09:00"] });
		const other = item("Інша", { key: "t2" });
		const cmds = buildCommands("act", [{ key: "t1", item: it1 }, { key: "t2", item: other }], "", snap) as any[];
		expect(cmds.map((c) => c.type)).toEqual(["item_add", "reminder_add", "reminder_add", "item_add"]);
		expect(cmds[1]).toEqual({
			type: "reminder_add",
			uuid: "act-0r0",
			temp_id: "tmp-act-0r0",
			args: { item_id: "tmp-act-0", type: "relative", minute_offset: 60 },
		});
		expect(cmds[2]).toEqual({
			type: "reminder_add",
			uuid: "act-0r1",
			temp_id: "tmp-act-0r1",
			args: { item_id: "tmp-act-0", type: "absolute", due: { date: "2026-11-11T09:00:00" } },
		});
	});
	it("оновлення зі зміною: reminder_delete для старих, потім reminder_add з id задачі", () => {
		const next = item("Зустріч", { key: "t1", due: "2026-11-11T16:00", reminders: ["before:30"] });
		const cmds = buildCommands("act", [{ key: "t1", item: next, id: "100", reminders: true, oldReminderIds: ["a", "b"] }], "", snap) as any[];
		expect(cmds.map((c) => c.type)).toEqual(["item_update", "reminder_delete", "reminder_delete", "reminder_add"]);
		expect(cmds[1]).toEqual({ type: "reminder_delete", uuid: "act-0rd0", args: { id: "a" } });
		expect(cmds[2]).toEqual({ type: "reminder_delete", uuid: "act-0rd1", args: { id: "b" } });
		expect(cmds[3]).toEqual({
			type: "reminder_add",
			uuid: "act-0r0",
			temp_id: "tmp-act-0r0",
			args: { item_id: "100", type: "relative", minute_offset: 30 },
		});
	});
	it("оновлення без прапорця reminders → жодних команд нагадувань; видалення всіх нагадувань → лише delete", () => {
		const withR = item("А", { reminders: ["before:30"] });
		expect(buildCommands("act", [{ key: "t1", item: withR, id: "100" }], "", snap)).toHaveLength(1);
		const cleared = item("А", { reminders: [] });
		const cmds = buildCommands("act", [{ key: "t1", item: cleared, id: "100", reminders: true, oldReminderIds: ["a"] }], "", snap) as any[];
		expect(cmds.map((c) => c.type)).toEqual(["item_update", "reminder_delete"]);
	});
	it("задача без reminders (стара нотатка) → без команд нагадувань", () => {
		expect(buildCommands("act", [{ key: "t1", item: item("А") }], "", snap)).toHaveLength(1);
	});
});

describe("buildCommands", () => {
	it("створення: item_add з тимчасовим id, project_id, пріоритетом 5-p і датами", () => {
		const it1 = item("Задача", { key: "t1", project: "Work", labels: ["Errand"], priority: 1, due: "2026-11-10", deadline: "2026-11-20" });
		expect(buildCommands("act", [{ key: "t1", item: it1 }], "опис", snap)).toEqual([
			{
				type: "item_add",
				uuid: "act-0",
				temp_id: "tmp-act-0",
				args: {
					content: "Задача",
					labels: ["Errand"],
					priority: 4,
					description: "опис",
					project_id: "work-id",
					due: { date: "2026-11-10" },
					deadline: { date: "2026-11-20" },
				},
			},
		]);
	});
	it("створення в Inbox: без project_id, без due і deadline; p4 → 1", () => {
		const [cmd] = buildCommands("act", [{ key: "t1", item: item("Задача", { key: "t1" }) }], "опис", snap) as any[];
		expect(cmd.args).toEqual({ content: "Задача", labels: [], priority: 1, description: "опис" });
		expect("project_id" in cmd.args).toBe(false);
	});
	it("оновлення: повні поля, null для порожніх дат, без опису", () => {
		const cmds = buildCommands("act", [{ key: "t1", item: item("Нова", { priority: 3 }), id: "100" }], "опис", snap);
		expect(cmds).toEqual([
			{
				type: "item_update",
				uuid: "act-0",
				args: { id: "100", content: "Нова", labels: [], priority: 2, due: null, deadline: null },
			},
		]);
	});
	it("перенесення в проєкт, якого немає у знімку: лише item_update, без item_move", () => {
		const cmds = buildCommands("act", [{ key: "t1", item: item("Н", { project: "Видалений" }), id: "100", move: true }], "", snap);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]).toMatchObject({ type: "item_update", uuid: "act-0" });
	});
	it("оновлення з перенесенням: item_update + item_move з суфіксом m", () => {
		const cmds = buildCommands("act", [{ key: "t1", item: item("Н", { project: "Home" }), id: "100", move: true }], "", snap);
		expect(cmds).toHaveLength(2);
		expect(cmds[1]).toEqual({ type: "item_move", uuid: "act-0m", args: { id: "100", project_id: "home-id" } });
	});
	it("перенесення в Inbox використовує id вхідних", () => {
		const cmds = buildCommands("act", [{ key: "t1", item: item("Н"), id: "100", move: true }], "", snap);
		expect(cmds[1]).toEqual({ type: "item_move", uuid: "act-0m", args: { id: "100", project_id: "inbox-id" } });
	});
	it("видалення: item_delete; uuid містить номер операції", () => {
		const cmds = buildCommands(
			"act",
			[
				{ key: "t1", item: item("А") },
				{ key: "t2", item: null, id: "200" },
			],
			"",
			snap,
		);
		expect(cmds[1]).toEqual({ type: "item_delete", uuid: "act-1", args: { id: "200" } });
	});
});

describe("buildCommands: подробиці", () => {
	it("створення: опис = «подробиці\\n\\nопис», а без подробиць — лише опис", () => {
		const [withD] = buildCommands("act", [{ key: "t1", item: item("А", { details: "Взяти паспорт" }) }], "опис", snap) as any[];
		expect(withD.args.description).toBe("Взяти паспорт\n\nопис");
		const [empty] = buildCommands("act", [{ key: "t1", item: item("А", { details: "" }) }], "опис", snap) as any[];
		expect(empty.args.description).toBe("опис");
	});
	it("оновлення: description лише коли describe:true", () => {
		const it1 = item("А", { details: "Нові" });
		const [on] = buildCommands("act", [{ key: "t1", item: it1, id: "100", describe: true }], "опис", snap) as any[];
		expect(on.args.description).toBe("Нові\n\nопис");
		const [off] = buildCommands("act", [{ key: "t1", item: it1, id: "100" }], "опис", snap) as any[];
		expect("description" in off.args).toBe(false);
	});
});

describe("formatTriage", () => {
	it("проєкт, пріоритет, мітки й дати; Inbox за замовчуванням", () => {
		const text = formatTriage([
			item("А", { key: "t1", project: "Work", priority: 1, labels: ["Errand"], due: "2026-11-10", deadline: "2026-11-20" }),
			item("Б", { key: "t2" }),
		]);
		expect(text).toBe("• А → Work p1 @Errand 📅 2026-11-10 ⏰ 2026-11-20\n• Б → Inbox");
	});
	it("лише маркери «•», без ☑️", () => {
		const text = formatTriage([item("А", { key: "t1" }), item("Б", { key: "t2" })]);
		expect(text).toBe("• А → Inbox\n• Б → Inbox");
		expect(text).not.toContain("☑️");
	});
	it("дублікат показується як «вже є»", () => {
		expect(formatTriage([item("Молоко", { key: "t1", duplicateOf: "Купити молоко" })])).toBe("• ↩️ вже є: Купити молоко");
	});
	it("нагадування: 🔔 −N хв і 🔔 дата час; без reminders нічого", () => {
		expect(formatTriage([item("А", { due: "2026-11-11T16:00", reminders: ["before:60", "2026-11-11T09:00"] })])).toBe(
			"• А → Inbox 📅 2026-11-11 16:00 🔔 −60 хв 🔔 2026-11-11 09:00",
		);
		expect(formatTriage([item("А", { reminders: [] }), item("Б")])).toBe("• А → Inbox\n• Б → Inbox");
	});
	it("p4 не показується", () => {
		expect(formatTriage([item("А", { priority: 4 })])).not.toMatch(/p4/);
	});
});

describe("deleteOpenTasks", () => {
	afterEach(() => vi.unstubAllGlobals());

	const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
	const items = [
		{ id: "1" },
		{ id: "2", checked: true },
		{ id: "3", is_deleted: true },
		{ id: "4" },
	];
	function stubFetch(write: unknown) {
		const calls: { body: URLSearchParams }[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
			calls.push({ body: init.body });
			return json(calls.length === 1 ? { items } : write);
		});
		return calls;
	}

	it("порожній список → 0, без запитів", async () => {
		const calls = stubFetch({});
		expect(await todoistTracker(fakeEnv({ TODOIST_TOKEN: "tok" })).deleteOpenTasks([])).toBe(0);
		expect(calls).toHaveLength(0);
	});
	it("видаляє лише відкриті; виконані, видалені й невідомі пропускає", async () => {
		const calls = stubFetch({ sync_status: { "delete-1": "ok", "delete-4": "ok" } });
		expect(await todoistTracker(fakeEnv({ TODOIST_TOKEN: "tok" })).deleteOpenTasks(["1", "2", "3", "4", "999"])).toBe(2);
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[1].body.get("commands")!)).toEqual([
			{ type: "item_delete", uuid: "delete-1", args: { id: "1" } },
			{ type: "item_delete", uuid: "delete-4", args: { id: "4" } },
		]);
	});
	it("відкритих немає → 0, лише запит на читання", async () => {
		const calls = stubFetch({});
		expect(await todoistTracker(fakeEnv({ TODOIST_TOKEN: "tok" })).deleteOpenTasks(["2", "3", "999"])).toBe(0);
		expect(calls).toHaveLength(1);
	});
	it("неуспішний sync_status → помилка", async () => {
		stubFetch({ sync_status: { "delete-1": { error_code: 22, error: "Invalid" } } });
		await expect(todoistTracker(fakeEnv({ TODOIST_TOKEN: "tok" })).deleteOpenTasks(["1"])).rejects.toThrow(/Todoist delete failed/);
	});
});

describe("applyOps", () => {
	afterEach(() => vi.unstubAllGlobals());

	const raw = {
		projects: [
			{ id: "inbox-id", name: "Inbox", inbox_project: true },
			{ id: "work-id", name: "Work" },
			{ id: "home-id", name: "Home" },
			{ id: "rules-id", name: RULES_PROJECT, description: "[правила]" },
		],
		labels: [{ name: "Errand" }],
		items: [],
	};
	const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

	// fetch-заглушка: перший виклик — читання знімка, другий — запис команд.
	function stubFetch(write: unknown) {
		const calls: { url: string; auth: string; body: URLSearchParams }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: URLSearchParams }) => {
			calls.push({ url, auth: init.headers.authorization, body: init.body });
			return json(calls.length === 1 ? raw : write);
		});
		return calls;
	}

	const created = item("Нова", { key: "t3", project: "Work", priority: 2 });
	const updated = item("Оновлена", { key: "t1", project: "" });
	const prev = item("Стара", { key: "t1", project: "Home" });
	const ops = [
		{ key: "t3", item: created },
		{ key: "t1", item: updated, id: "100", move: true },
		{ key: "t2", item: null, id: "200" },
	];
	const seed = (env: ReturnType<typeof fakeEnv>) =>
		env.store.set("notes/n1.tasks.json", JSON.stringify({ t1: { id: "100", item: prev }, t2: { id: "200", item: item("В", { key: "t2" }) } }));

	it("надсилає команди й зберігає id створених задач", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		seed(env);
		const id = await prepare(env, ops, "опис", "n1");
		prepared.get(id)!.messageUrl = "https://t.me/c/1/2";
		const calls = stubFetch({
			sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: "ok", [`${id}-1m`]: "ok", [`${id}-2`]: "ok" },
			temp_id_mapping: { [`tmp-${id}-0`]: "300" },
		});

		expect(await applyPrepared(env, id)).toBe(true);

		expect(calls).toHaveLength(2);
		expect(calls[0].url).toBe("https://api.todoist.com/api/v1/sync");
		expect(calls[0].auth).toBe("Bearer tok");
		expect(calls[0].body.get("sync_token")).toBe("*");
		const commands = JSON.parse(calls[1].body.get("commands")!);
		expect(commands).toEqual([
			{
				type: "item_add",
				uuid: `${id}-0`,
				temp_id: `tmp-${id}-0`,
				args: { content: "Нова", labels: [], priority: 3, description: "опис\nhttps://t.me/c/1/2", project_id: "work-id" },
			},
			{ type: "item_update", uuid: `${id}-1`, args: { id: "100", content: "Оновлена", labels: [], priority: 1, due: null, deadline: null } },
			{ type: "item_move", uuid: `${id}-1m`, args: { id: "100", project_id: "inbox-id" } },
			{ type: "item_delete", uuid: `${id}-2`, args: { id: "200" } },
		]);

		const state = await r2Ledger(env).get("n1");
		expect(state).toEqual({ t3: { id: "300", item: created }, t1: { id: "100", item: updated } });
	});

	it("неуспішний sync_status → помилка, стан нотатки не змінено", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		seed(env);
		const before = env.store.get("notes/n1.tasks.json");
		const id = await prepare(env, ops, "опис", "n1");
		stubFetch({ sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: { error_code: 22, error: "Invalid" } }, temp_id_mapping: {} });

		await expect(applyPrepared(env, id)).rejects.toThrow(/Task tracker commands failed/);
		expect(env.store.get("notes/n1.tasks.json")).toBe(before);

		// після помилки ретрай проходить
		stubFetch({ sync_status: {}, temp_id_mapping: { [`tmp-${id}-0`]: "300" } });
		expect(await applyPrepared(env, id)).toBe(true);
	});

	it("частковий збій: id успішно створеної задачі зберігається, ретрай завершує", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const a = item("Перша", { key: "t1" });
		const b = item("Друга", { key: "t2" });
		const id = await prepare(
			env,
			[
				{ key: "t1", item: a },
				{ key: "t2", item: b },
			],
			"о",
			"n1",
		);
		stubFetch({
			sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: { error_code: 15, error: "Fail" } },
			temp_id_mapping: { [`tmp-${id}-0`]: "301" },
		});
		await expect(applyPrepared(env, id)).rejects.toThrow(/Task tracker commands failed/);
		expect(await r2Ledger(env).get("n1")).toEqual({ t1: { id: "301", item: a } });

		const calls = stubFetch({
			sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: "ok" },
			temp_id_mapping: { [`tmp-${id}-0`]: "301", [`tmp-${id}-1`]: "302" },
		});
		expect(await applyPrepared(env, id)).toBe(true);
		// ретрай надсилає ті самі uuid — Todoist не виконає їх удруге
		const uuids = JSON.parse(calls[1].body.get("commands")!).map((c: { uuid: string }) => c.uuid);
		expect(uuids).toEqual([`${id}-0`, `${id}-1`]);
		expect(await r2Ledger(env).get("n1")).toEqual({ t1: { id: "301", item: a }, t2: { id: "302", item: b } });
	});

	it("нагадування: ID зберігаються для створення й заміни; оновлення без змін нагадувань лишає попередні", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const withR = item("З нагадуванням", { key: "t3", due: "2026-11-11T16:00", reminders: ["before:60", "2026-11-11T09:00"] });
		const replaced = item("Заміна", { key: "t1", due: "2026-11-11T16:00", reminders: ["before:30"] });
		const kept = item("Перейменована", { key: "t2", due: "2026-11-11T16:00", reminders: ["before:15"] });
		const none = item("Без нагадувань", { key: "t4" });
		env.store.set(
			"notes/n1.tasks.json",
			JSON.stringify({
				t1: { id: "100", item: item("Стара", { key: "t1", due: "2026-11-11T16:00", reminders: ["before:60"] }), reminderIds: ["old1"] },
				t2: { id: "200", item: { ...kept, title: "Було" }, reminderIds: ["old2"] },
			}),
		);
		const id = await prepare(
			env,
			[
				{ key: "t3", item: withR },
				{ key: "t1", item: replaced, id: "100", reminders: true, oldReminderIds: ["old1"] },
				{ key: "t2", item: kept, id: "200" },
				{ key: "t4", item: none },
			],
			"о",
			"n1",
		);
		const calls = stubFetch({
			sync_status: Object.fromEntries(
				[`${id}-0`, `${id}-0r0`, `${id}-0r1`, `${id}-1`, `${id}-1rd0`, `${id}-1r0`, `${id}-2`, `${id}-3`].map((k) => [k, "ok"]),
			),
			temp_id_mapping: {
				[`tmp-${id}-0`]: "300",
				[`tmp-${id}-0r0`]: "r300a",
				[`tmp-${id}-0r1`]: "r300b",
				[`tmp-${id}-1r0`]: "new1",
				[`tmp-${id}-3`]: "400",
			},
		});
		await applyPrepared(env, id);

		const types = JSON.parse(calls[1].body.get("commands")!).map((c: { type: string }) => c.type);
		expect(types).toEqual([
			"item_add",
			"reminder_add",
			"reminder_add",
			"item_update",
			"reminder_delete",
			"reminder_add",
			"item_update",
			"item_add",
		]);
		expect(await r2Ledger(env).get("n1")).toEqual({
			t3: { id: "300", item: withR, reminderIds: ["r300a", "r300b"] },
			t1: { id: "100", item: replaced, reminderIds: ["new1"] },
			t2: { id: "200", item: kept, reminderIds: ["old2"] },
			t4: { id: "400", item: none },
		});
	});

	it("HTTP-помилка Todoist → виняток", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const id = await prepare(env, [{ key: "t3", item: created }], "о", "n1");
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 401, text: async () => "forbidden" }));
		await expect(applyPrepared(env, id)).rejects.toThrow(/401/);
	});
});

describe("час у даті виконання", () => {
	const snapT: TrackerSnapshot = { projects: [{ id: "i", name: "Inbox", inbox: true }], labels: [], tasks: [], rules: "" };
	const v = taskValidator(snapT, new Date("2026-11-10T08:00:00Z"), "Europe/Kyiv");
	const due = (d: string, deadline = "") => v({ title: "Х", due: d, deadline });

	it.each([
		["today 13:00", "2026-11-10T13:00"],
		["tomorrow 9:05", "2026-11-11T09:05"],
		["2026-11-12T19:00", "2026-11-12T19:00"],
		["2026-11-12 19:00:00", "2026-11-12T19:00"],
		["today@7:30", "2026-11-10T07:30"],
		["today 25:00", "2026-11-10"],
		["today", "2026-11-10"],
		["о 13:00", ""],
	])("%s → %s", (input, expected) => expect(due(input).due).toBe(expected));

	it("дедлайн у той самий день, що й дата виконання, відкидається; пізніший лишається; час у дедлайні ігнорується", () => {
		expect(due("today 13:00", "today").deadline).toBe("");
		expect(due("today 13:00", "2026-11-14").deadline).toBe("2026-11-14");
		expect(due("", "tomorrow 18:00").deadline).toBe("2026-11-11");
	});

	it("у Todoist іде «плаваючий» час з секундами, у підписі — через пробіл", () => {
		const it1: TriageItem = { title: "Надіслати фото", duplicateOf: "", project: "", labels: [], priority: 2, due: "2026-11-10T13:00", deadline: "" };
		const [cmd] = buildCommands("a", [{ key: "t1", item: it1 }], "", snapT);
		expect(cmd.args.due).toEqual({ date: "2026-11-10T13:00:00" });
		expect(formatTriage([it1])).toBe("• Надіслати фото → Inbox p2 📅 2026-11-10 13:00");
	});
});

describe("fetchSnapshot: правила", () => {
	const proj = (name: string, description = "", extra: object = {}) => ({ id: name, name, description, ...extra });
	const mock = (projects: object[], pages: { results: object[]; next_cursor: string | null }[] = []) => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			calls.push(url);
			if (url.includes("/projects/archived")) {
				const cursor = new URL(url).searchParams.get("cursor");
				const i = cursor ? Number(cursor) : 0;
				return { ok: true, json: async () => pages[i] ?? { results: [], next_cursor: null } };
			}
			return { ok: true, json: async () => ({ projects, labels: [{ name: "Errand" }], items: [{ content: "Купити молоко" }] }) };
		});
		return calls;
	};
	const env = fakeEnv({ TODOIST_TOKEN: "tok" });

	it("активний проєкт правил: опис звідти, архів не читається, проєкт не в projects", async () => {
		const calls = mock([proj("Inbox", "", { inbox_project: true }), proj("Work"), proj(RULES_PROJECT, "  [правила]\np1 — терміново \n")]);
		const s = await fetchSnapshot(env);
		expect(s.rules).toBe("[правила]\np1 — терміново");
		expect(s.projects.map((p) => p.name)).toEqual(["Inbox", "Work"]);
		expect(calls.some((u) => u.includes("archived"))).toBe(false);
	});

	it("архівний проєкт правил із пагінацією через next_cursor", async () => {
		const calls = mock(
			[proj("Inbox", "", { inbox_project: true }), proj("Work")],
			[
				{ results: [proj("Старий")], next_cursor: "1" },
				{ results: [proj(RULES_PROJECT, "[мітки]\nErrand — вдома")], next_cursor: null },
			],
		);
		const s = await fetchSnapshot(env);
		expect(s.rules).toBe("[мітки]\nErrand — вдома");
		expect(s.projects.map((p) => p.name)).toEqual(["Inbox", "Work"]);
		const archived = calls.filter((u) => u.includes("archived"));
		expect(archived).toHaveLength(2);
		expect(archived[0]).toContain("limit=200");
		expect(archived[1]).toContain("cursor=1");
	});

	it("is_archived у /sync теж ігнорується, правила беруться з архіву", async () => {
		mock([proj("Work"), proj(RULES_PROJECT, "зі sync", { is_archived: true })], [{ results: [proj(RULES_PROJECT, "з архіву")], next_cursor: null }]);
		expect((await fetchSnapshot(env)).rules).toBe("з архіву");
	});

	it("проєкту немає ніде → rules \"\" і console.error", async () => {
		mock([proj("Work")], [{ results: [proj("Старий")], next_cursor: null }]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const s = await fetchSnapshot(env);
		expect(s.rules).toBe("");
		expect(err).toHaveBeenCalledOnce();
		err.mockRestore();
	});

	it("findRulesProject: активний → id та опис; в архіві → id; ніде → null", async () => {
		mock([], [{ results: [proj(RULES_PROJECT, "арх")], next_cursor: null }]);
		expect(await findRulesProject(env, [{ id: "a1", name: RULES_PROJECT, description: "акт" }])).toEqual({ id: "a1", description: "акт" });
		expect(await findRulesProject(env, [])).toEqual({ id: RULES_PROJECT, description: "арх" });
		mock([], [{ results: [], next_cursor: null }]);
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await findRulesProject(env, [])).toBeNull();
		err.mockRestore();
	});

	it("taskRulesBlock: snap.rules або (no rules)", () => {
		expect(taskRulesBlock({ ...snap, rules: "[правила]\nабв" })).toContain("<rules>\n[правила]\nабв\n</rules>");
		const empty = taskRulesBlock({ ...snap, rules: "" });
		expect(empty).toContain("(no rules)");
		expect(empty).not.toContain("абв");
	});
});

describe("повторювані задачі", () => {
	const v = taskValidator(snap, new Date("2026-11-10T08:00:00Z"), "Europe/Kyiv");

	describe("taskValidator: recurrence", () => {
		it("фраза з every нормалізується (регістр, пробіли); підпис береться з recurrence_label", () => {
			expect(v({ title: "Х", recurrence: "  Every   Monday at 9:00 ", recurrence_label: " щопонеділка о 9:00 " })).toMatchObject({
				recurrence: "every monday at 9:00",
				recurrenceLabel: "щопонеділка о 9:00",
			});
		});
		it("без recurrence_label підпис = фраза", () => {
			expect(v({ title: "Х", recurrence: "every 2 weeks" })).toMatchObject({ recurrence: "every 2 weeks", recurrenceLabel: "every 2 weeks" });
		});
		it("не «every» → порожні recurrence і підпис", () => {
			for (const recurrence of ["", "daily", "everyday", "each monday", "щодня", " ", 5, null]) {
				expect(v({ title: "Х", recurrence, recurrence_label: "щодня" })).toMatchObject({ recurrence: "", recurrenceLabel: "" });
			}
		});
		it("recurrence_label без recurrence ігнорується", () => {
			expect(v({ title: "Х", recurrence_label: "щодня" })).toMatchObject({ recurrence: "", recurrenceLabel: "" });
		});
		it("due зберігається разом із повтором", () => {
			expect(v({ title: "Х", due: "2026-11-16 09:00", recurrence: "every monday at 9:00" })).toMatchObject({
				due: "2026-11-16T09:00",
				recurrence: "every monday at 9:00",
			});
		});
	});

	describe("buildCommands: due", () => {
		const rec = item("Звіт", { key: "t1", due: "2026-11-16T09:00", recurrence: "every monday at 9:00", recurrenceLabel: "щопонеділка о 9:00" });
		it("створення з повтором: due {string, lang:en} замість дати", () => {
			const [cmd] = buildCommands("act", [{ key: "t1", item: rec }], "", snap) as any[];
			expect(cmd.args.due).toEqual({ string: "every monday at 9:00", lang: "en" });
		});
		it("оновлення з повтором: те саме", () => {
			const [cmd] = buildCommands("act", [{ key: "t1", item: rec, id: "100" }], "", snap) as any[];
			expect(cmd.args.due).toEqual({ string: "every monday at 9:00", lang: "en" });
		});
		it("без повтору — дата (з часом — :00), без дати — null/відсутній", () => {
			const dated = item("А", { key: "t1", due: "2026-11-16T09:00", recurrence: "" });
			const [c1] = buildCommands("act", [{ key: "t1", item: dated, id: "100" }], "", snap) as any[];
			expect(c1.args.due).toEqual({ date: "2026-11-16T09:00:00" });
			const [c2] = buildCommands("act", [{ key: "t1", item: dated }], "", snap) as any[];
			expect(c2.args.due).toEqual({ date: "2026-11-16T09:00:00" });
			const [c3] = buildCommands("act", [{ key: "t1", item: item("Б", { key: "t1" }) }], "", snap) as any[];
			expect("due" in c3.args).toBe(false);
			const [c4] = buildCommands("act", [{ key: "t1", item: item("Б", { key: "t1" }), id: "100" }], "", snap) as any[];
			expect(c4.args.due).toBeNull();
		});
	});

	describe("planOps", () => {
		const base = item("Звіт", { key: "t1", due: "2026-11-16" });
		it("додано, змінено чи прибрано повтор → оновлення", () => {
			const rec = { ...base, recurrence: "every monday" };
			expect(planOps([rec], { t1: { id: "1", item: base } })).toHaveLength(1);
			expect(planOps([base], { t1: { id: "1", item: rec } })).toHaveLength(1);
			expect(planOps([{ ...rec, recurrence: "every tuesday" }], { t1: { id: "1", item: rec } })).toHaveLength(1);
		});
		it("той самий повтор, undefined і порожній рядок — без змін; інший підпис не зміна", () => {
			const rec = { ...base, recurrence: "every monday", recurrenceLabel: "щопонеділка" };
			expect(planOps([{ ...rec, recurrenceLabel: "щопонеділка." }], { t1: { id: "1", item: rec } })).toEqual([]);
			expect(planOps([{ ...base, recurrence: "" }], { t1: { id: "1", item: base } })).toEqual([]);
			expect(planOps([base], { t1: { id: "1", item: { ...base, recurrence: "" } } })).toEqual([]);
		});
	});

	describe("formatTriage", () => {
		it("показує 🔁 з підписом, інакше з фразою; без повтору — нічого", () => {
			expect(formatTriage([item("А", { key: "t1", due: "2026-11-16", recurrence: "every monday", recurrenceLabel: "щопонеділка" })])).toBe(
				"• А → Inbox 📅 2026-11-16 🔁 щопонеділка",
			);
			expect(formatTriage([item("А", { key: "t1", recurrence: "every day" })])).toBe("• А → Inbox 🔁 every day");
			expect(formatTriage([item("А", { key: "t1", recurrence: "", recurrenceLabel: "" })])).not.toContain("🔁");
		});
	});

	describe("applyOps: запасний шлях без повтору", () => {
		afterEach(() => vi.unstubAllGlobals());
		const raw = {
			projects: [
				{ id: "inbox-id", name: "Inbox", inbox_project: true },
				{ id: "rules-id", name: RULES_PROJECT, description: "[правила]" },
			],
			labels: [],
			items: [],
		};
		const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
		// перший fetch — знімок, далі — відповіді з `writes` по черзі
		function stub(...writes: unknown[]) {
			const calls: { body: URLSearchParams }[] = [];
			vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
				calls.push({ body: init.body });
				return json(calls.length === 1 ? raw : writes[calls.length - 2]);
			});
			return calls;
		}
		const invalid = { error_code: 17, error_tag: "INVALID_DATE", error: "Invalid date format" };
		const rec = item("Звіт", {
			key: "t1",
			due: "2026-11-16T09:00",
			recurrence: "every blah",
			recurrenceLabel: "якось",
			reminders: ["before:30", "2026-11-16T08:00"],
		});
		const plain = item("Інша", { key: "t2" });
		const ops = [
			{ key: "t1", item: rec },
			{ key: "t2", item: plain },
		];

		it("INVALID_DATE для повтору → другий sync лише з командами повтору (uuid з x), стан без повтору", async () => {
			const env = fakeEnv({ TODOIST_TOKEN: "tok" });
			const err = vi.spyOn(console, "error").mockImplementation(() => {});
			const id = await prepare(env, ops, "о", "n1");
			const calls = stub(
				{ sync_status: { [`${id}-0`]: invalid, [`${id}-1`]: "ok" }, temp_id_mapping: { [`tmp-${id}-1`]: "302" } },
				{
					sync_status: { [`${id}x-0`]: "ok", [`${id}x-0r0`]: "ok", [`${id}x-0r1`]: "ok" },
					temp_id_mapping: { [`tmp-${id}x-0`]: "301", [`tmp-${id}x-0r0`]: "r1", [`tmp-${id}x-0r1`]: "r2" },
				},
			);

			expect(await applyPrepared(env, id)).toBe(true);

			expect(calls).toHaveLength(3);
			const first = JSON.parse(calls[1].body.get("commands")!);
			expect(first[0].args.due).toEqual({ string: "every blah", lang: "en" });
			const retry = JSON.parse(calls[2].body.get("commands")!);
			expect(retry.map((c: { uuid: string }) => c.uuid)).toEqual([`${id}x-0`, `${id}x-0r0`, `${id}x-0r1`]);
			expect(retry[0]).toMatchObject({ type: "item_add", temp_id: `tmp-${id}x-0`, args: { content: "Звіт", due: { date: "2026-11-16T09:00:00" } } });
			expect(retry[1].args.item_id).toBe(`tmp-${id}x-0`);
			expect(JSON.stringify(retry)).not.toContain("every blah");

			const state = await r2Ledger(env).get("n1");
			expect(state.t1).toEqual({ id: "301", item: { ...rec, recurrence: "", recurrenceLabel: "" }, reminderIds: ["r1", "r2"] });
			expect(state.t2).toEqual({ id: "302", item: plain });
			expect(err).toHaveBeenCalledTimes(1);
			err.mockRestore();
		});

		it("INVALID_DATE у задачі без повтору або інша помилка → кидає, без повторного sync", async () => {
			const env = fakeEnv({ TODOIST_TOKEN: "tok" });
			const id = await prepare(env, ops, "о", "n1");
			const calls = stub({
				sync_status: { [`${id}-0`]: { error_code: 15, error_tag: "SOMETHING", error: "x" }, [`${id}-1`]: invalid },
				temp_id_mapping: {},
			});
			await expect(applyPrepared(env, id)).rejects.toThrow(/Task tracker commands failed/);
			expect(calls).toHaveLength(2);
		});

		it("помилка в самому ретраї → кидає; успішні задачі зберігаються", async () => {
			const env = fakeEnv({ TODOIST_TOKEN: "tok" });
			const err = vi.spyOn(console, "error").mockImplementation(() => {});
			const id = await prepare(env, ops, "о", "n1");
			stub(
				{ sync_status: { [`${id}-0`]: invalid, [`${id}-1`]: "ok" }, temp_id_mapping: { [`tmp-${id}-1`]: "302" } },
				{ sync_status: { [`${id}x-0`]: { error_code: 15, error_tag: "OTHER", error: "x" } }, temp_id_mapping: {} },
			);
			await expect(applyPrepared(env, id)).rejects.toThrow(/Task tracker commands failed/);
			expect(await r2Ledger(env).get("n1")).toEqual({ t2: { id: "302", item: plain } });
			err.mockRestore();
		});
	});

	describe("withAppliedRecurrence", () => {
		const rec = item("Звіт", { key: "t1", recurrence: "every day", recurrenceLabel: "щодня" });
		it("прибирає повтор, якщо в Todoist задача без повтору", () => {
			const inT: TrackedTasks = { t1: { id: "1", item: { ...rec, recurrence: "", recurrenceLabel: "" } } };
			expect(withAppliedRecurrence([rec], inT)).toEqual([{ ...rec, recurrence: "", recurrenceLabel: "" }]);
		});
		it("лишає повтор, якщо Todoist його прийняв або задачі ще немає; null → null", () => {
			expect(withAppliedRecurrence([rec], { t1: { id: "1", item: rec } })).toEqual([rec]);
			expect(withAppliedRecurrence([rec], {})).toEqual([rec]);
			expect(withAppliedRecurrence(null, {})).toBeNull();
		});
		it("задачі без повтору не змінюються", () => {
			const plain = item("А", { key: "t2" });
			expect(withAppliedRecurrence([plain], { t2: { id: "2", item: plain } })).toEqual([plain]);
		});
	});
});

describe("attachFile", () => {
	afterEach(() => vi.unstubAllGlobals());
	const env = fakeEnv({ TODOIST_TOKEN: "tok" });
	const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
	const stub = (syncStatus: Record<string, unknown>) => {
		const spy = vi.fn(async (url: string, _init: RequestInit) =>
			url.endsWith("/uploads") ? Response.json({ file_url: "https://x/f.jpg", file_name: "f.jpg" }) : Response.json({ sync_status: syncStatus }),
		);
		vi.stubGlobal("fetch", spy);
		return spy;
	};

	it("без задач нічого не завантажує", async () => {
		const spy = stub({});
		await todoistTracker(env).attachFile("a1", [], file, "f.jpg");
		expect(spy).not.toHaveBeenCalled();
	});

	it("завантажує файл і додає коментарі-вкладення зі сталими uuid", async () => {
		const spy = stub({ "a1-a0": "ok", "a1-a1": "ok" });
		await todoistTracker(env).attachFile("a1", ["t1", "t2"], file, "f.jpg");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0][0]).toContain("/uploads");
		const commands = JSON.parse(String((spy.mock.calls[1][1].body as URLSearchParams).get("commands")));
		expect(commands).toHaveLength(2);
		expect(commands[0]).toMatchObject({
			type: "note_add",
			uuid: "a1-a0",
			args: { item_id: "t1", file_attachment: { file_url: "https://x/f.jpg", file_name: "f.jpg" } },
		});
		expect(commands[1]).toMatchObject({ uuid: "a1-a1", args: { item_id: "t2" } });
	});

	it("кидає помилку, якщо команда не ok", async () => {
		stub({ "a1-a0": { error: "boom" } });
		await expect(todoistTracker(env).attachFile("a1", ["t1"], file, "f.jpg")).rejects.toThrow(/note_add/);
	});
});

describe("r2Ledger: ключ до перейменування", () => {
	it("читає старий ключ .todoist.json, якщо нового немає", async () => {
		const env = fakeEnv();
		env.store.set("notes/n1.todoist.json", JSON.stringify({ t1: { id: "100", item: item("А") } }));
		expect(Object.keys(await r2Ledger(env).get("n1"))).toEqual(["t1"]);
		env.store.set("notes/n1.tasks.json", JSON.stringify({ t2: { id: "200", item: item("Б") } }));
		expect(Object.keys(await r2Ledger(env).get("n1"))).toEqual(["t2"]);
	});
});

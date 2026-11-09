import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyAction,
	buildCommands,
	createAction,
	formatTriage,
	getInTodoist,
	planOps,
	setActionMessage,
	taskValidator,
	type InTodoist,
	type TodoistSnapshot,
	type TriageItem,
} from "../src/todoist";
import { fakeEnv } from "./fake-env";

const snap: TodoistSnapshot = {
	projects: [
		{ id: "inbox-id", name: "Inbox", inbox: true },
		{ id: "work-id", name: "Work", inbox: false },
		{ id: "home-id", name: "Home", inbox: false },
	],
	labels: ["Errand", "Home", "Waiting"],
	tasks: ["Купити молоко", "Подзвонити Іллі"],
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
});

describe("planOps", () => {
	const prev = item("Старе", { key: "t1", project: "Work", labels: ["Errand"], priority: 2, due: "2026-11-10" });
	const inTodoist: InTodoist = { t1: { id: "100", item: prev }, t2: { id: "200", item: item("Видалене", { key: "t2" }) } };

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

describe("formatTriage", () => {
	it("проєкт, пріоритет, мітки й дати; Inbox за замовчуванням", () => {
		const text = formatTriage([
			item("А", { key: "t1", project: "Work", priority: 1, labels: ["Errand"], due: "2026-11-10", deadline: "2026-11-20" }),
			item("Б", { key: "t2" }),
		]);
		expect(text).toBe("• А → Work p1 @Errand 📅 2026-11-10 ⏰ 2026-11-20\n• Б → Inbox");
	});
	it("☑️ для задач, що вже в Todoist (за ключем)", () => {
		const text = formatTriage([item("А", { key: "t1" }), item("Б", { key: "t2" })], new Set(["t1"]));
		expect(text).toBe("☑️ А → Inbox\n• Б → Inbox");
	});
	it("дублікат показується як «вже є»", () => {
		expect(formatTriage([item("Молоко", { key: "t1", duplicateOf: "Купити молоко" })])).toBe("• ↩️ вже є: Купити молоко");
	});
	it("p4 не показується", () => {
		expect(formatTriage([item("А", { priority: 4 })])).not.toMatch(/p4/);
	});
});

describe("applyAction", () => {
	afterEach(() => vi.unstubAllGlobals());

	const raw = {
		projects: [
			{ id: "inbox-id", name: "Inbox", inbox_project: true },
			{ id: "work-id", name: "Work" },
			{ id: "home-id", name: "Home" },
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
		env.store.set("notes/n1.todoist.json", JSON.stringify({ t1: { id: "100", item: prev }, t2: { id: "200", item: item("В", { key: "t2" }) } }));

	it("надсилає команди, зберігає id створених задач, позначає дію виконаною", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		seed(env);
		const id = await createAction(env, ops, "опис", "n1");
		await setActionMessage(env, id, "https://t.me/c/1/2");
		const calls = stubFetch({
			sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: "ok", [`${id}-1m`]: "ok", [`${id}-2`]: "ok" },
			temp_id_mapping: { [`tmp-${id}-0`]: "300" },
		});

		expect(await applyAction(env, id)).toEqual({ status: "applied", noteId: "n1", count: 3 });

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

		const state = await getInTodoist(env, "n1");
		expect(state).toEqual({ t3: { id: "300", item: created }, t1: { id: "100", item: updated } });
	});

	it("повторний виклик → already, без запитів до Todoist", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const id = await createAction(env, [{ key: "t3", item: created }], "о", "n1");
		const calls = stubFetch({ sync_status: {}, temp_id_mapping: { [`tmp-${id}-0`]: "300" } });
		await applyAction(env, id);
		expect(await applyAction(env, id)).toEqual({ status: "already" });
		expect(calls).toHaveLength(2);
	});

	it("невідома дія → missing", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const calls = stubFetch({});
		expect(await applyAction(env, "нема")).toEqual({ status: "missing" });
		expect(calls).toHaveLength(0);
	});

	it("неуспішний sync_status → помилка, дію не позначено виконаною, стан нотатки не змінено", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		seed(env);
		const before = env.store.get("notes/n1.todoist.json");
		const id = await createAction(env, ops, "опис", "n1");
		stubFetch({ sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: { error_code: 22, error: "Invalid" } }, temp_id_mapping: {} });

		await expect(applyAction(env, id)).rejects.toThrow(/Todoist commands failed/);
		expect(JSON.parse(env.store.get(`todoist/${id}.json`)!).appliedAt).toBeUndefined();
		expect(env.store.get("notes/n1.todoist.json")).toBe(before);

		// після помилки можна натиснути ще раз
		stubFetch({ sync_status: {}, temp_id_mapping: { [`tmp-${id}-0`]: "300" } });
		expect((await applyAction(env, id)).status).toBe("applied");
	});

	it("частковий збій: id успішно створеної задачі зберігається, дія не виконана, ретрай завершує", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const a = item("Перша", { key: "t1" });
		const b = item("Друга", { key: "t2" });
		const id = await createAction(
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
		await expect(applyAction(env, id)).rejects.toThrow(/Todoist commands failed/);
		expect(await getInTodoist(env, "n1")).toEqual({ t1: { id: "301", item: a } });
		expect(JSON.parse(env.store.get(`todoist/${id}.json`)!).appliedAt).toBeUndefined();

		const calls = stubFetch({
			sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: "ok" },
			temp_id_mapping: { [`tmp-${id}-0`]: "301", [`tmp-${id}-1`]: "302" },
		});
		expect(await applyAction(env, id)).toEqual({ status: "applied", noteId: "n1", count: 2 });
		// ретрай надсилає ті самі uuid — Todoist не виконає їх удруге
		const uuids = JSON.parse(calls[1].body.get("commands")!).map((c: { uuid: string }) => c.uuid);
		expect(uuids).toEqual([`${id}-0`, `${id}-1`]);
		expect(await getInTodoist(env, "n1")).toEqual({ t1: { id: "301", item: a }, t2: { id: "302", item: b } });
		expect(JSON.parse(env.store.get(`todoist/${id}.json`)!).appliedAt).toBeDefined();
	});

	it("HTTP-помилка Todoist → виняток", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const id = await createAction(env, [{ key: "t3", item: created }], "о", "n1");
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 401, text: async () => "forbidden" }));
		await expect(applyAction(env, id)).rejects.toThrow(/401/);
	});
});

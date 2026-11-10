import { afterEach, describe, expect, it, vi } from "vitest";
import { labelRule, planSetup, setLabelRule, setupCommands, setupReport, validateSetup, type SetupPlan, type SetupWorld } from "../src/setup";
import { RULES_PROJECT } from "../src/todoist";
import { fakeEnv } from "./fake-env";

afterEach(() => vi.unstubAllGlobals());

describe("labelRule / setLabelRule", () => {
	const rules = "[пріоритети]\np1 — терміново\n\n[мітки]\nErrand — по дорозі\nWaiting — чекаю на інших\n\n[інше]\nабв";

	it("labelRule: знаходить опис, без урахування регістру, з будь-яким тире", () => {
		expect(labelRule(rules, "Errand")).toBe("по дорозі");
		expect(labelRule(rules, "errand")).toBe("по дорозі");
		expect(labelRule("[мітки]\nA – один\nB - два\nC — три", "A")).toBe("один");
		expect(labelRule("[мітки]\nA – один\nB - два\nC — три", "B")).toBe("два");
		expect(labelRule("[МІТКИ]\nA — x", "a")).toBe("x");
	});
	it("labelRule: нема мітки чи секції → \"\"; рядок з іншої секції не береться", () => {
		expect(labelRule(rules, "Home")).toBe("");
		expect(labelRule("p1 — терміново", "p1")).toBe("");
		expect(labelRule(rules, "p1")).toBe("");
	});
	it("setLabelRule: замінює існуючий рядок", () => {
		expect(setLabelRule(rules, "errand", "вдома")).toBe(rules.replace("Errand — по дорозі", "errand — вдома"));
	});
	it("setLabelRule: вставляє після останнього непорожнього рядка секції, до наступної [секції]", () => {
		expect(setLabelRule(rules, "Online", "онлайн")).toBe(
			"[пріоритети]\np1 — терміново\n\n[мітки]\nErrand — по дорозі\nWaiting — чекаю на інших\nOnline — онлайн\n\n[інше]\nабв",
		);
	});
	it("setLabelRule: секція в кінці без наступної", () => {
		expect(setLabelRule("[мітки]\nA — x\n", "B", "y")).toBe("[мітки]\nA — x\nB — y\n");
	});
	it("setLabelRule: прибирає рядок", () => {
		expect(setLabelRule(rules, "Errand", null)).toBe(rules.replace("Errand — по дорозі\n", ""));
		expect(setLabelRule(rules, "Нема", null)).toBe(rules);
	});
	it("setLabelRule: немає секції → додається в кінець; видалення нічого не змінює", () => {
		expect(setLabelRule("[правила]\nабв\n", "A", "x")).toBe("[правила]\nабв\n\n[мітки]\nA — x");
		expect(setLabelRule("", "A", "x")).toBe("[мітки]\nA — x");
		expect(setLabelRule("[правила]\nабв", "A", null)).toBe("[правила]\nабв");
	});
	it("спецсимволи в назві мітки не ламають регулярку", () => {
		expect(labelRule("[мітки]\nC++ — мова", "C++")).toBe("мова");
	});
});

describe("validateSetup", () => {
	const world = (over: Partial<SetupWorld> = {}): SetupWorld => ({
		projects: [
			{ id: "p-work", name: "Work", description: "", openTasks: 3 },
			{ id: "p-home", name: "Home", description: "старий", openTasks: 0 },
		],
		labels: [
			{ id: "l-err", name: "Errand" },
			{ id: "l-wait", name: "Waiting" },
		],
		rules: { id: "p-rules", text: "[мітки]\nErrand — по дорозі" },
		...over,
	});
	const c = (kind: string, action: string, name: string, new_name = "", description = "") => ({ kind, action, name, new_name, description });

	it("create нового проєкту й мітки; # та @ і пробіли прибираються", () => {
		const p = validateSetup([c("project", "create", "  Спорт ", "", "тренування"), c("label", "create", "@Online", "", "онлайн")], world());
		expect(p.changes).toEqual([
			{ kind: "project", action: "create", name: "Спорт", newName: "", description: "тренування" },
			{ kind: "label", action: "create", name: "Online", newName: "", description: "онлайн" },
		]);
		expect(p.rules).toEqual({ projectId: "p-rules", text: "[мітки]\nErrand — по дорозі\nOnline — онлайн" });
	});
	it("create без опису мітки не чіпає правила", () => {
		const p = validateSetup([c("label", "create", "Online")], world());
		expect(p.changes).toHaveLength(1);
		expect(p.rules).toBeUndefined();
	});
	it("мітка з пробілом і зарезервовані назви пропускаються", () => {
		const p = validateSetup(
			[c("label", "create", "Дуже важливо"), c("project", "create", "inbox"), c("project", "create", "Вхідні"), c("project", "create", RULES_PROJECT), c("project", "create", "⚙️ правила")],
			world(),
		);
		expect(p.changes).toEqual([]);
	});
	it("назви існуючих порівнюються без урахування регістру", () => {
		const p = validateSetup([c("project", "delete", "work")], world());
		expect(p.changes).toEqual([{ kind: "project", action: "delete", name: "Work", newName: "", description: "", id: "p-work", openTasks: 3 }]);
	});
	it("create існуючого без опису — пропуск; з описом — describe", () => {
		expect(validateSetup([c("project", "create", "work")], world()).changes).toEqual([]);
		const p = validateSetup([c("project", "create", "work", "", "робота")], world());
		expect(p.changes).toEqual([{ kind: "project", action: "describe", name: "Work", newName: "", description: "робота", id: "p-work" }]);
	});
	it("describe проєкту: лише зміна в проєкті, правила не чіпаються", () => {
		const p = validateSetup([c("project", "describe", "Home", "", "дім")], world());
		expect(p.changes).toHaveLength(1);
		expect(p.rules).toBeUndefined();
	});
	it("describe без опису або неіснуючого — пропуск", () => {
		expect(validateSetup([c("project", "describe", "Home"), c("project", "describe", "Нема", "", "x")], world()).changes).toEqual([]);
	});
	it("describe мітки → зміна й нові правила", () => {
		const p = validateSetup([c("label", "describe", "errand", "", "вдома")], world());
		expect(p.changes).toEqual([{ kind: "label", action: "describe", name: "Errand", newName: "", description: "вдома", id: "l-err" }]);
		expect(p.rules?.text).toBe("[мітки]\nErrand — вдома");
	});
	it("rules без змін (той самий опис) → без plan.rules", () => {
		const p = validateSetup([c("label", "describe", "Errand", "", "по дорозі")], world());
		expect(p.changes).toHaveLength(1);
		expect(p.rules).toBeUndefined();
	});
	it("немає проєкту правил → describe мітки пропускається, без rules", () => {
		const p = validateSetup([c("label", "describe", "Errand", "", "вдома")], world({ rules: null }));
		expect(p).toEqual({ changes: [] });
	});
	it("немає проєкту правил → create мітки працює, rules немає", () => {
		const p = validateSetup([c("label", "create", "Online", "", "x")], world({ rules: null }));
		expect(p.changes).toHaveLength(1);
		expect(p.rules).toBeUndefined();
	});
	it("rename проєкту", () => {
		const p = validateSetup([c("project", "rename", "Home", "Дім")], world());
		expect(p.changes).toEqual([{ kind: "project", action: "rename", name: "Home", newName: "Дім", description: "", id: "p-home" }]);
	});
	it("rename: конфлікт імен, те саме ім'я, зарезервоване, пробіл у мітці — пропуск", () => {
		const p = validateSetup(
			[c("project", "rename", "Home", "work"), c("project", "rename", "Home", "Home"), c("project", "rename", "Home", "Inbox"), c("label", "rename", "Errand", "Дві мітки"), c("label", "rename", "Errand", "Waiting")],
			world(),
		);
		expect(p.changes).toEqual([]);
	});
	it("rename мітки переносить рядок правил під нову назву", () => {
		const p = validateSetup([c("label", "rename", "Errand", "Дорога")], world());
		expect(p.changes[0]).toMatchObject({ action: "rename", name: "Errand", newName: "Дорога", id: "l-err" });
		expect(p.rules?.text).toBe("[мітки]\nДорога — по дорозі");
	});
	it("послідовність: rename, потім describe за новою назвою", () => {
		const p = validateSetup([c("label", "rename", "Errand", "Дорога"), c("label", "describe", "Дорога", "", "у дорозі")], world());
		expect(p.changes.map((x) => [x.action, x.name, x.id])).toEqual([
			["rename", "Errand", "l-err"],
			["describe", "Дорога", "l-err"],
		]);
		expect(p.rules?.text).toBe("[мітки]\nДорога — у дорозі");
	});
	it("послідовність: після rename стара назва вже не існує", () => {
		const p = validateSetup([c("project", "rename", "Home", "Дім"), c("project", "delete", "Home")], world());
		expect(p.changes).toHaveLength(1);
	});
	it("послідовність: delete, потім create тієї ж назви", () => {
		const p = validateSetup([c("project", "delete", "Home"), c("project", "create", "Home")], world());
		expect(p.changes.map((x) => x.action)).toEqual(["delete", "create"]);
	});
	it("delete проєкту записує openTasks; delete мітки прибирає рядок правил", () => {
		const p = validateSetup([c("project", "delete", "Home"), c("project", "delete", "Work"), c("label", "delete", "Errand")], world());
		expect(p.changes.map((x) => x.openTasks)).toEqual([0, 3, undefined]);
		expect(p.rules?.text).toBe("[мітки]");
	});
	it("сміття: невідомі kind/action, порожня назва, неіснуючий delete", () => {
		const p = validateSetup([c("task", "create", "X"), c("project", "move", "X"), c("project", "create", ""), c("project", "delete", "Нема")], world());
		expect(p.changes).toEqual([]);
	});
});

describe("setupCommands", () => {
	const plan: SetupPlan = {
		changes: [
			{ kind: "project", action: "create", name: "Спорт", newName: "", description: "тренування" },
			{ kind: "project", action: "rename", name: "Home", newName: "Дім", description: "", id: "p1" },
			{ kind: "project", action: "describe", name: "Work", newName: "", description: "робота", id: "p2" },
			{ kind: "project", action: "delete", name: "A", newName: "", description: "", id: "p3", openTasks: 2 },
			{ kind: "project", action: "delete", name: "B", newName: "", description: "", id: "p4", openTasks: 0 },
			{ kind: "label", action: "create", name: "Online", newName: "", description: "x" },
			{ kind: "label", action: "rename", name: "Errand", newName: "Дорога", description: "", id: "l1" },
			{ kind: "label", action: "describe", name: "Waiting", newName: "", description: "y", id: "l2" },
			{ kind: "label", action: "delete", name: "Old", newName: "", description: "", id: "l3" },
		],
		rules: { projectId: "pr", text: "[мітки]\nOnline — x" },
	};

	it("форми команд і сталі uuid (id + номер зміни)", () => {
		expect(setupCommands("abc", plan)).toEqual([
			{ type: "project_add", uuid: "abc-s0", temp_id: "tmp-abc-s0", args: { name: "Спорт", description: "тренування" } },
			{ type: "project_update", uuid: "abc-s1", args: { id: "p1", name: "Дім" } },
			{ type: "project_update", uuid: "abc-s2", args: { id: "p2", description: "робота" } },
			{ type: "project_archive", uuid: "abc-s3", args: { id: "p3" } },
			{ type: "project_delete", uuid: "abc-s4", args: { id: "p4" } },
			{ type: "label_add", uuid: "abc-s5", temp_id: "tmp-abc-s5", args: { name: "Online" } },
			{ type: "label_update", uuid: "abc-s6", args: { id: "l1", name: "Дорога" } },
			// label describe → без команди (індекс 7 пропущено)
			{ type: "label_delete", uuid: "abc-s8", args: { id: "l3" } },
			{ type: "project_update", uuid: "abc-rules", args: { id: "pr", description: "[мітки]\nOnline — x" } },
		]);
	});
	it("ті самі вхідні дані → ті самі uuid", () => {
		expect(setupCommands("abc", plan)).toEqual(setupCommands("abc", plan));
	});
	it("create проєкту без опису не має description; без rules немає команди правил", () => {
		const cmds = setupCommands("x", { changes: [{ kind: "project", action: "create", name: "P", newName: "", description: "" }] });
		expect(cmds).toEqual([{ type: "project_add", uuid: "x-s0", temp_id: "tmp-x-s0", args: { name: "P" } }]);
	});
	it("лише опис мітки → тільки команда правил", () => {
		const cmds = setupCommands("x", {
			changes: [{ kind: "label", action: "describe", name: "A", newName: "", description: "d", id: "l" }],
			rules: { projectId: "pr", text: "t" },
		});
		expect(cmds).toEqual([{ type: "project_update", uuid: "x-rules", args: { id: "pr", description: "t" } }]);
	});
});

describe("setupReport", () => {
	it("рядки для кожної дії", () => {
		const plan: SetupPlan = {
			changes: [
				{ kind: "project", action: "create", name: "Спорт", newName: "", description: "тренування" },
				{ kind: "label", action: "create", name: "Online", newName: "", description: "" },
				{ kind: "project", action: "rename", name: "Home", newName: "Дім", description: "", id: "1" },
				{ kind: "label", action: "describe", name: "Errand", newName: "", description: "вдома", id: "2" },
				{ kind: "project", action: "delete", name: "A", newName: "", description: "", id: "3", openTasks: 2 },
				{ kind: "project", action: "delete", name: "B", newName: "", description: "", id: "4", openTasks: 0 },
				{ kind: "label", action: "delete", name: "Old", newName: "", description: "", id: "5" },
			],
		};
		expect(setupReport(plan)).toEqual([
			"➕ Проєкт «Спорт» — тренування",
			"➕ Мітка «Online»",
			"✏️ Проєкт «Home» → «Дім»",
			"📝 Мітка «Errand» — вдома",
			"🗄 Проєкт «A» в архіві (відкритих задач у ньому: 2)",
			"🗑 Проєкт «B» видалено",
			"🗑 Мітка «Old» видалено",
		]);
	});
});

describe("planSetup", () => {
	it("без слів про проєкти/мітки — порожній план без жодного fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		expect(await planSetup(env, "Купити молоко і подзвонити Іллі", false)).toEqual({ changes: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("без TODOIST_TOKEN — теж порожній план без fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(await planSetup(fakeEnv(), "створи проєкт Спорт", false)).toEqual({ changes: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

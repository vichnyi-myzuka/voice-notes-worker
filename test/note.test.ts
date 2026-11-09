import { describe, expect, it } from "vitest";
import { buildCaption, formatCaption, hashtags, isoWeek, parseEditedNote, parseMeta, plainTasks } from "../src/note";
import { taskValidator, type TodoistSnapshot, type TriageItem } from "../src/todoist";

const snap: TodoistSnapshot = {
	projects: [
		{ id: "p0", name: "Inbox", inbox: true },
		{ id: "p1", name: "Gifts", inbox: false },
		{ id: "p2", name: "Personal affairs", inbox: false },
		{ id: "p3", name: "Home", inbox: false },
		{ id: "p4", name: "Shopping", inbox: false },
		{ id: "p5", name: "Work", inbox: false },
	],
	labels: ["Critical", "High", "Errand"],
	tasks: ["Купити молоко"],
};
const validate = taskValidator(snap, new Date("2026-11-09T10:00:00Z"), "Europe/Kyiv");
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

describe("isoWeek", () => {
	it.each([
		[2026, 11, 9, 46],
		[2026, 1, 1, 1],
		[2025, 12, 29, 1],
		[2027, 1, 3, 53],
		[2026, 12, 31, 53],
		[2024, 12, 30, 1],
		[2021, 1, 3, 53],
		[2020, 12, 31, 53],
		[2026, 6, 15, 25],
	])("%i-%i-%i → %i", (y, m, d, w) => expect(isoWeek(y, m, d)).toBe(w));
});

describe("hashtags", () => {
	it("місяць словом, тиждень і проєкти нових задач без дублікатів", () => {
		const tags = hashtags(new Date("2026-11-09T10:00:00Z"), "Europe/Kyiv", [
			item("a", { project: "Work" }),
			item("b", { project: "Personal affairs" }),
			item("c", { project: "Work" }),
			item("d", { project: "Home", duplicateOf: "x" }),
		]);
		expect(tags).toBe("#листопад_2026 #тиждень_46 #Work #Personal_affairs");
	});
	it("дата рахується в TIMEZONE: 31.12 23:30 UTC — це вже січень у Києві", () => {
		expect(hashtags(new Date("2026-12-31T23:30:00Z"), "Europe/Kyiv", null)).toBe("#січень_2027 #тиждень_53");
	});
});

describe("parseMeta", () => {
	it("розбирає JSON навіть з текстом навколо", () => {
		expect(parseMeta('ось: {"title":"Т","summary":"С","ideas":[" i "],"tasks":[],"discard":"none"}')).toEqual({
			title: "Т",
			summary: "С",
			ideas: ["i"],
			tasks: [],
		});
	});
	it.each(["empty", "cancelled"])("discard=%s повертає порожню нотатку", (d) => {
		expect(parseMeta(JSON.stringify({ title: "", summary: "", discard: d })).discard).toBe(d);
	});
	it("без назви — помилка (тоді askJson спробує іншу модель)", () => {
		expect(() => parseMeta('{"title":"","summary":"С","discard":"none"}')).toThrow();
	});
});

describe("caption", () => {
	const meta = { title: "Назва", summary: "Опис.", ideas: [], tasks: ["Купити хліб"] };
	it("порожні секції не показуються", () => {
		expect(formatCaption(meta, null)).toBe("Назва\n\nОпис.\n\n✅ Задачі:\n• Купити хліб");
	});
	it("довгий підпис обрізається, а примітка й хештеги лишаються, загалом ≤ 1024", () => {
		const long = { ...meta, summary: "дуже ".repeat(400) };
		const c = buildCaption(long, null, Date.parse("2026-11-09T10:00:00Z"), "Europe/Kyiv", "ℹ️ примітка");
		expect(c.length).toBeLessThanOrEqual(1024);
		expect(c.endsWith("ℹ️ примітка\n\n#листопад_2026 #тиждень_46")).toBe(true);
		expect(c).toContain("…");
	});
});

describe("parseEditedNote", () => {
	const old = [
		item("Скасувати зустріч", { key: "t1", project: "Work" }),
		item("Купити молоко", { key: "t2", duplicateOf: "Купити молоко" }),
	];
	const answer = (tasks: object[]) => JSON.stringify({ title: "Н", summary: "С", ideas: [], discard: "none", tasks });
	const task = (key: string, title: string, extra: object = {}) => ({
		key,
		title,
		project: "",
		labels: [],
		priority: "p4",
		due: "",
		deadline: "",
		...extra,
	});

	it("зберігає відомі ключі, дає нові ключі новим і повторним, переносить позначку дубліката", () => {
		const { meta, triage } = parseEditedNote(
			answer([
				task("t1", "Скасувати зустріч", { project: "Work", due: "2026-11-12", priority: "p1" }),
				task("t2", "Купити молоко", { project: "Shopping" }),
				task("", "Купити квіти", { project: "Gifts", labels: ["Critical"] }),
				task("t1", "Повтор ключа"),
				task("t99", "Вигаданий ключ"),
			]),
			old,
			validate,
		);
		expect(triage!.map((i) => i.key)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
		expect(triage![0]).toMatchObject({ due: "2026-11-12", priority: 1 });
		expect(triage![1].duplicateOf).toBe("Купити молоко");
		expect(triage![2]).toMatchObject({ project: "Gifts", labels: ["Critical"], duplicateOf: "" });
		expect(meta.tasks).toEqual(["Скасувати зустріч", "Купити молоко", "Купити квіти", "Повтор ключа", "Вигаданий ключ"]);
	});
	it("валідує поля Todoist: неіснуючі проєкт і мітка відкидаються, дата й пріоритет нормалізуються", () => {
		const { triage } = parseEditedNote(
			answer([task("t1", "Х", { project: "Нема", labels: ["Вигаданий", "High"], priority: "p9", due: "колись", deadline: "завтра" })]),
			old,
			validate,
		);
		expect(triage![0]).toMatchObject({ project: "", labels: ["High"], priority: 4, due: "", deadline: "" });
	});
	it("«today» і «tomorrow» у правці перетворюються на дати відносно дати валідатора", () => {
		const { triage } = parseEditedNote(
			answer([task("t1", "А", { due: "today", deadline: "tomorrow" }), task("t2", "Б", { due: "tomorrow" })]),
			old,
			validate,
		);
		expect(triage![0]).toMatchObject({ due: "2026-11-09", deadline: "2026-11-10" });
		expect(triage![1].due).toBe("2026-11-10");
	});
	it("без Todoist повертає лише назви задач, без тріажу", () => {
		const r = parseEditedNote(answer([{ key: "t1", title: "Х" }]), plainTasks(["Х"]), null);
		expect(r.triage).toBeNull();
		expect(r.meta.tasks).toEqual(["Х"]);
	});
	it("скасування правки", () => {
		expect(parseEditedNote(JSON.stringify({ discard: "cancelled" }), old, validate).meta.discard).toBe("cancelled");
	});
});

import { describe, expect, it } from "vitest";
import { buildCaption, formatCaption, hashtags, isoWeek, parseEditedNote, parseMeta, plainTasks } from "../src/note";
import type { ThingsSnapshot, TriageItem } from "../src/things";

const snap: ThingsSnapshot = {
	projects: [],
	areas: ["Gifts", "Personal affairs", "Home", "Shopping", "Work", "Want"],
	todos: ["Купити молоко"],
};
const item = (title: string, extra: Partial<TriageItem> = {}): TriageItem => ({
	title,
	duplicateOf: "",
	list: "",
	tags: [],
	when: "",
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
	it("місяць словом, тиждень і області нових задач без дублікатів", () => {
		const tags = hashtags(new Date("2026-11-09T10:00:00Z"), "Europe/Kyiv", [
			item("a", { list: "Work" }),
			item("b", { list: "Personal affairs" }),
			item("c", { list: "Work" }),
			item("d", { list: "Home", duplicateOf: "x" }),
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
		item("Скасувати зустріч", { key: "t1", list: "Work" }),
		item("Купити молоко", { key: "t2", duplicateOf: "Купити молоко" }),
	];
	const answer = (tasks: object[]) => JSON.stringify({ title: "Н", summary: "С", ideas: [], discard: "none", tasks });
	const task = (key: string, title: string, extra: object = {}) => ({ key, title, list: "", tags: [], when: "", deadline: "", ...extra });

	it("зберігає відомі ключі, дає нові ключі новим і повторним, переносить позначку дубліката", () => {
		const { meta, triage } = parseEditedNote(
			answer([
				task("t1", "Скасувати зустріч", { list: "Work", when: "today" }),
				task("t2", "Купити молоко", { list: "Shopping" }),
				task("", "Купити квіти", { list: "Gifts", tags: ["Critical"] }),
				task("t1", "Повтор ключа"),
				task("t99", "Вигаданий ключ"),
			]),
			old,
			snap,
		);
		expect(triage!.map((i) => i.key)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
		expect(triage![0].when).toBe("today");
		expect(triage![1].duplicateOf).toBe("Купити молоко");
		expect(triage![2]).toMatchObject({ list: "Gifts", tags: ["Critical"], duplicateOf: "" });
		expect(meta.tasks).toEqual(["Скасувати зустріч", "Купити молоко", "Купити квіти", "Повтор ключа", "Вигаданий ключ"]);
	});
	it("валідує поля Things: неіснуюча область і тег відкидаються", () => {
		const { triage } = parseEditedNote(
			answer([task("t1", "Х", { list: "Нема", tags: ["Вигаданий", "High"], when: "колись", deadline: "завтра" })]),
			old,
			snap,
		);
		expect(triage![0]).toMatchObject({ list: "", tags: ["High"], when: "anytime", deadline: "" });
	});
	it("без знімка повертає лише назви задач, без тріажу", () => {
		const r = parseEditedNote(answer([{ key: "t1", title: "Х" }]), plainTasks(["Х"]), null);
		expect(r.triage).toBeNull();
		expect(r.meta.tasks).toEqual(["Х"]);
	});
	it("скасування правки", () => {
		expect(parseEditedNote(JSON.stringify({ discard: "cancelled" }), old, snap).meta.discard).toBe("cancelled");
	});
});

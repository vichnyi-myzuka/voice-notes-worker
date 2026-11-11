import { describe, expect, it } from "vitest";
import { buildCaption, formatCaption, hashtags, isoWeek, parseEditedNote, parseMeta, plainTasks, taskLinks } from "../src/domain/note";
import { TEXT_CAPTION_MAX } from "@voice-notes/core";
import type { TrackerSnapshot, TriageItem } from "../src/domain/tracker";
import { taskUrl } from "../src/infrastructure/todoist";
import { taskValidator } from "../src/infrastructure/todoist/fields";

const snap: TrackerSnapshot = {
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
	rules: "",
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
		expect(tags).toBe("#листопад_2026 #тиждень_46 #день_2026_11_09 #Work #Personal_affairs");
	});
	it("дата рахується в TIMEZONE: 31.12 23:30 UTC — це вже січень у Києві", () => {
		expect(hashtags(new Date("2026-12-31T23:30:00Z"), "Europe/Kyiv", null)).toBe("#січень_2027 #тиждень_53 #день_2027_01_01");
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
	it("discard=delete повертає порожню нотатку (видалення цілої нотатки)", () => {
		expect(parseMeta('{"discard":"delete"}')).toEqual({ title: "", summary: "", ideas: [], tasks: [], discard: "delete" });
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
		const c = buildCaption(long, null, Date.parse("2026-11-09T10:00:00Z"), "Europe/Kyiv", "ℹ️ примітка", 1024);
		expect(c.length).toBeLessThanOrEqual(1024);
		expect(c.endsWith("ℹ️ примітка\n\n#листопад_2026 #тиждень_46 #день_2026_11_09")).toBe(true);
		expect(c).toContain("…");
	});
});

describe("taskLinks", () => {
	const url = (id: string) => `https://app.todoist.com/app/task/${id}`;
	const make = (summary: string, titles: string[], ideas: string[] = []) => {
		const triage = titles.map((t, i) => item(t, { key: `t${i + 1}` }));
		const meta = { title: "Назва", summary, ideas, tasks: titles };
		return { triage, caption: buildCaption(meta, triage, Date.parse("2026-11-09T10:00:00Z"), "Europe/Kyiv", "", 1024) };
	};
	const texts = (caption: string, links: { offset: number; length: number }[]) =>
		links.map((l) => caption.slice(l.offset, l.offset + l.length));

	it("offset/length у UTF-16 після емодзі та не-BMP символів", () => {
		const { triage, caption } = make("Опис 🎉 з емодзі 😀.", ["Купити хліб", "Зателефонувати мамі"], ["Думка 𝒳"]);
		const links = taskLinks(caption, triage, { t1: "11", t2: "22" }, taskUrl);
		expect(texts(caption, links)).toEqual(["Купити хліб", "Зателефонувати мамі"]);
		expect(links.map((l) => l.url)).toEqual([url("11"), url("22")]);
	});
	it("назва і в summary, і в задачах — посилання на рядок задачі", () => {
		const { triage, caption } = make("Треба Купити хліб сьогодні", ["Купити хліб"]);
		const [link] = taskLinks(caption, triage, { t1: "11" }, taskUrl);
		expect(link.offset).toBeGreaterThan(caption.indexOf("✅ Задачі:"));
		expect(caption.slice(link.offset - 3, link.offset + link.length)).toBe("\n• Купити хліб");
	});
	it("дублікат і задача без id не отримують посилання", () => {
		const triage = [
			item("А", { key: "t1", duplicateOf: "Існуюча" }),
			item("Б", { key: "t2" }),
			item("В", { key: "t3" }),
		];
		const caption = buildCaption(
			{ title: "Н", summary: "С", ideas: [], tasks: ["А", "Б", "В"] },
			triage,
			Date.parse("2026-11-09T10:00:00Z"),
			"Europe/Kyiv",
			"",
			1024,
		);
		const links = taskLinks(caption, triage, { t1: "1", t3: "3" }, taskUrl);
		expect(texts(caption, links)).toEqual(["В"]);
		expect(links[0].url).toBe(url("3"));
	});
	it("однакова назва двічі — два окремі посилання", () => {
		const { triage, caption } = make("С", ["Позвонити", "Позвонити"]);
		const links = taskLinks(caption, triage, { t1: "1", t2: "2" }, taskUrl);
		expect(texts(caption, links)).toEqual(["Позвонити", "Позвонити"]);
		expect(links[0].offset).toBeLessThan(links[1].offset);
		expect(links.map((l) => l.url)).toEqual([url("1"), url("2")]);
	});
	it("довге summary скорочується, а всі задачі лишаються з посиланнями", () => {
		const titles = ["Перша задача", "Друга задача", "Третя задача", "Четверта задача"];
		const { triage, caption } = make("дуже ".repeat(190), titles, ["Думка, яка не влізе"]);
		expect(caption.length).toBeLessThanOrEqual(1024);
		expect(caption).not.toContain("Ключові думки");
		const links = taskLinks(caption, triage, { t1: "1", t2: "2", t3: "3", t4: "4" }, taskUrl);
		expect(texts(caption, links)).toEqual(titles);
	});
	it("задачі, що не влазять, замінює рядок «…і ще N у Todoist»", () => {
		const titles = Array.from({ length: 30 }, (_, i) => `Задача номер ${i + 1} з досить довгою назвою`);
		const { triage, caption } = make("Короткий опис.", titles);
		expect(caption.length).toBeLessThanOrEqual(1024);
		const shown = titles.filter((t) => caption.includes(`• ${t} →`)).length;
		expect(shown).toBeGreaterThan(5);
		expect(shown).toBeLessThan(30);
		expect(caption).toContain(`…і ще ${30 - shown} у Todoist`);
		expect(caption).toContain("Короткий опис.");
		const links = taskLinks(caption, triage, Object.fromEntries(titles.map((_, i) => [`t${i + 1}`, String(i)])), taskUrl);
		expect(links.length).toBe(shown);
	});
	it("текстова нотатка вміщує більше (TEXT_CAPTION_MAX)", () => {
		const titles = Array.from({ length: 30 }, (_, i) => `Задача номер ${i + 1} з досить довгою назвою`);
		const triage = titles.map((t, i) => item(t, { key: `t${i + 1}` }));
		const caption = buildCaption({ title: "Н", summary: "С", ideas: [], tasks: titles }, triage, Date.parse("2026-11-09T10:00:00Z"), "Europe/Kyiv", "", TEXT_CAPTION_MAX);
		expect(caption.length).toBeLessThanOrEqual(TEXT_CAPTION_MAX);
		expect(titles.filter((t) => caption.includes(`• ${t} →`)).length).toBe(30);
	});
	it("без «✅ Задачі:» — порожній список", () => {
		const caption = "Назва\n\nОпис\n\n#листопад_2026";
		expect(taskLinks(caption, [item("А", { key: "t1" })], { t1: "1" }, taskUrl)).toEqual([]);
		expect(taskLinks(caption, null, {}, taskUrl)).toEqual([]);
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
	it("нагадування проходять через валідатор: нормалізація, відкидання некоректних", () => {
		const { triage } = parseEditedNote(
			answer([
				task("t1", "А", { due: "today 16:00", reminders: ["before 60", "tomorrow 09:00", "tomorrow", "before 60"] }),
				task("t2", "Б", { due: "2026-11-12", reminders: ["before 30"] }),
			]),
			old,
			validate,
		);
		expect(triage![0].reminders).toEqual(["before:60", "2026-11-10T09:00"]);
		expect(triage![1].reminders).toEqual([]);
	});
	it("повтор проходить через валідатор: нормалізація, підпис, відкидання не-«every»", () => {
		const { triage } = parseEditedNote(
			answer([
				task("t1", "А", { due: "2026-11-10", recurrence: "Every Tuesday", recurrence_label: "щовівторка" }),
				task("t2", "Б", { recurrence: "щодня", recurrence_label: "щодня" }),
			]),
			old,
			validate,
		);
		expect(triage![0]).toMatchObject({ recurrence: "every tuesday", recurrenceLabel: "щовівторка" });
		expect(triage![1]).toMatchObject({ recurrence: "", recurrenceLabel: "" });
	});
	it("без Todoist повертає лише назви задач, без тріажу", () => {
		const r = parseEditedNote(answer([{ key: "t1", title: "Х" }]), plainTasks(["Х"]), null);
		expect(r.triage).toBeNull();
		expect(r.meta.tasks).toEqual(["Х"]);
	});
	it("видалення нотатки: discard=delete, без тріажу", () => {
		const r = parseEditedNote(JSON.stringify({ discard: "delete" }), old, validate);
		expect(r.meta.discard).toBe("delete");
		expect(r.triage).toBeNull();
	});
	it("скасування правки", () => {
		expect(parseEditedNote(JSON.stringify({ discard: "cancelled" }), old, validate).meta.discard).toBe("cancelled");
	});
});

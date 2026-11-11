import type { TodoistSnapshot, TriageItem } from "./types";
import { isoDate } from "./api";

export const listNames = (snap: TodoistSnapshot) => snap.projects.filter((p) => !p.inbox).map((p) => p.name);

// Поля задачі Todoist у JSON-схемі: enum гарантує, що модель не вигадає неіснуючий проєкт чи мітку.
export function taskFieldsSchema(snap: TodoistSnapshot): Record<string, unknown> {
	return {
		project: { type: "string", enum: ["", ...listNames(snap)] },
		labels: snap.labels.length
			? { type: "array", items: { type: "string", enum: snap.labels } }
			: { type: "array", items: { type: "string" } },
		priority: { type: "string", enum: ["p1", "p2", "p3", "p4"] },
		due: { type: "string" },
		deadline: { type: "string" },
		recurrence: { type: "string" },
		recurrence_label: { type: "string" },
		reminders: { type: "array", items: { type: "string" } },
		details: { type: "string" },
	};
}

// Правила автора, мітки й проєкти — і для тріажу, і для редагування задач.
// Що означає кожен проєкт, автор пише в описі проєкту в Todoist: «Назва — опис».
export function taskRulesBlock(snap: TodoistSnapshot): string {
	const projects = snap.projects
		.filter((p) => !p.inbox)
		.map((p) => (p.description ? `${p.name} — ${p.description.replace(/\s*\n\s*/g, " ")}` : p.name));
	return [
		`<rules>\n${snap.rules || "(no rules)"}\n</rules>`,
		`<labels>\n${snap.labels.join("\n")}\n</labels>`,
		`<projects>\n${projects.join("\n")}\n</projects>`,
	].join("\n\n");
}

export const TASK_FIELDS_HELP = `- project: a project from <projects> (name before " — "; the rest is what the project is for) that clearly fits the task, or "" (Inbox) if none clearly fits. Never guess.
- labels: labels from <labels> that clearly apply, or [] if none.
- priority: "p1" (highest) … "p4" (no priority), following the rules.
- due: when the task should be done, only if said: "today", "tomorrow" or YYYY-MM-DD, plus " HH:MM" if a time is said ("до 13:00", "о 19:00" → "today 13:00", "today 19:00"); otherwise "".
- deadline: a date YYYY-MM-DD only if a separate final deadline is mentioned that is later than due (e.g. "почати завтра, здати до п'ятниці"); never repeat the due date as a deadline; otherwise "".
- recurrence: only if the author says the task repeats ("щодня", "щопонеділка", "кожні два тижні", "раз на місяць", "щороку 1 березня"): a Todoist recurring date in English that starts with "every", with the time if said: "every day", "every weekday", "every monday at 9:00", "every 2 weeks", "every month on the 5th", "every year on march 1"; otherwise "". When set, due is the first occurrence (with the time, if said).
  Regular intake or procedures over several days ("двічі на день протягом 5 днів", "тричі на день тиждень", "щоранку до 20 листопада") are recurring too.
  Limited period ("протягом 7 днів", "тиждень", "до 20 листопада"): add " until YYYY-MM-DD" with the last day, counting the first day as day 1 ("протягом 7 днів" from 2026-11-10 → "every day until 2026-11-16"); for a range ("2–3 дні") take the longer one.
  Several times a day ("двічі на день", "тричі на день"): Todoist cannot repeat a task several times a day, so use "every day" (with "until" if limited) and keep the per-day frequency in the title.
- recurrence_label: the same repetition in short Ukrainian for display ("щопонеділка о 9:00", "кожні 2 тижні", "щодня до 16.11"), or "" when there is no recurrence.
- reminders: only if the author explicitly asks to be reminded ("нагадай…"): "before N" = N minutes before the due time (only when due has a time, e.g. "нагадай за годину" → "before 60"), or an absolute "today HH:MM" / "tomorrow HH:MM" / "YYYY-MM-DD HH:MM" ("нагадай завтра о 9" → "tomorrow 09:00"); otherwise [].
- details: a description of the task in Ukrainian with the specifics the author said that don't fit in the title: what exactly, how, why, names, amounts, addresses, links, list items, conditions. Use the author's facts only, never invent or pad, no timing (it is in due/recurrence). One to a few short sentences or "• " lines; "" if the title already says everything.
- Task titles never contain dates, timing words or durations ("завтра", "19 листопада", "протягом 7 днів", "щодня"): timing goes only to due/deadline/recurrence. What to do and how much stays in the title, including dosage and per-day frequency ("Приймати Нольпазу 40 мг — 1 таблетку зранку за 30 хвилин до їжі", "Промивати ніс Носолем тричі на день").`;

// Перевіряє поля задачі, які повернула модель (Gemma може не дотримуватись enum).
// "today"/"tomorrow" перетворюються на дату відносно base (дата запису або правки).
export function taskValidator(snap: TodoistSnapshot, base: Date, timeZone: string): (r: Record<string, unknown>) => TriageItem {
	const taskByKey = new Map(snap.tasks.map((t) => [normalize(t), t]));
	const projects = new Set(listNames(snap));
	const labels = new Set(snap.labels);
	const dateRe = /^\d{4}-\d{2}-\d{2}$/;
	// Календарні дні від дати base у timeZone (не +24 год: так перехід на літній час не зсуває дату).
	const [y, m, d] = isoDate(base, timeZone).split("-").map(Number);
	const day = (offset: number) => new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
	const date = (v: unknown) => {
		const s = String(v ?? "").trim();
		return s === "today" ? day(0) : s === "tomorrow" ? day(1) : dateRe.test(s) ? s : "";
	};
	// Дата з необов'язковим часом: "today 13:00", "2026-11-10T13:00", "2026-11-10 9:05" → "2026-11-10T13:00".
	const dateTime = (v: unknown) => {
		const [, dayPart, hh, mm] = String(v ?? "").trim().match(/^(\S+?)(?:[ T@](\d{1,2}):(\d{2})(?::\d{2})?)?$/) ?? [];
		const ymd = date(dayPart);
		if (!ymd || hh === undefined) return ymd;
		return Number(hh) < 24 && Number(mm) < 60 ? `${ymd}T${hh.padStart(2, "0")}:${mm}` : ymd;
	};
	// Нагадування: "before 60" → "before:60" (лише коли в дати виконання є час), дата з часом → YYYY-MM-DDTHH:MM.
	const reminders = (v: unknown, dueHasTime: boolean): string[] => {
		const out = (Array.isArray(v) ? v : []).map((x) => {
			const rel = String(x).trim().match(/^before[ :]?(\d{1,4})$/);
			if (rel) return dueHasTime && Number(rel[1]) > 0 ? `before:${Number(rel[1])}` : "";
			const at = dateTime(x);
			return at.includes("T") ? at : ""; // нагадування без часу Todoist не підтримує
		});
		return [...new Set(out.filter(Boolean))];
	};
	// Повтор: лише фраза Todoist, що починається з "every"; без неї й підпис порожній.
	const recurrence = (r: Record<string, unknown>) => {
		const every = String(r.recurrence ?? "").trim().toLowerCase().replace(/\s+/g, " ");
		if (!/^every\b/.test(every)) return { recurrence: "", recurrenceLabel: "" };
		return { recurrence: every, recurrenceLabel: String(r.recurrence_label ?? "").trim() || every };
	};
	return (r) => {
		const project = projects.has(String(r.project ?? "").trim()) ? String(r.project).trim() : "";
		const priority = Number(String(r.priority ?? "").replace(/^p/, ""));
		return {
			title: String(r.title ?? "").trim(),
			duplicateOf: taskByKey.get(normalize(String(r.duplicate_of ?? ""))) ?? "",
			project,
			// Лише існуючі мітки, без повторів і без мітки, що збігається з назвою проєкту (Home у Home).
			labels: Array.isArray(r.labels)
				? [...new Set(r.labels.map(String))].filter((l) => labels.has(l) && normalize(l) !== normalize(project))
				: [],
			priority: priority >= 1 && priority <= 4 ? priority : 4,
			due: dateTime(r.due),
			...recurrence(r),
			reminders: reminders(r.reminders, dateTime(r.due).includes("T")),
			details: String(r.details ?? "").trim(),
			// Дедлайн, що збігається з датою виконання, лише дублює її.
			deadline: ((dl) => (dl && dl !== dateTime(r.due).slice(0, 10) ? dl : ""))(date(String(r.deadline ?? "").trim().split(/[ T@]/)[0])),
		};
	};
}

export function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

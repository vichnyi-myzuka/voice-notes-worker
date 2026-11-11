import type { TextLink } from "@voice-notes/core";
import type { TriageItem } from "../tracker";
import type { Meta } from "./types";

// Підпис до аудіо: назва, summary і (якщо є) списки думок і задач.
// Якщо був тріаж, задачі показуються з проєктом, тегами, датами й позначкою дублікатів.
export function formatCaption({ title, summary, ideas, tasks }: Meta, triaged: TriageItem[] | null): string {
	const parts = [title, summary];
	if (ideas.length) parts.push(`💡 Ключові думки:\n${ideas.map((i) => `• ${i}`).join("\n")}`);
	if (triaged?.length) parts.push(`✅ Задачі:\n${formatTriage(triaged)}`);
	else if (tasks.length) parts.push(`✅ Задачі:\n${tasks.map((t) => `• ${t}`).join("\n")}`);
	return parts.join("\n\n");
}

// Підпис з хештегами окремим рядком у кінці: вони не обрізаються разом з довгим текстом.
export function buildCaption(
	meta: Meta,
	triaged: TriageItem[] | null,
	ts: number,
	timeZone: string,
	notice: string,
	max: number,
): string {
	const tail = [notice, hashtags(new Date(ts), timeZone, triaged)].filter(Boolean).join("\n\n");
	return `${fitCaption(meta, triaged, max - tail.length - 2)}\n\n${tail}`;
}

// Підпис у межах room. Задачі важливіші за решту: спершу прибираємо ключові думки, потім скорочуємо
// summary, і лише тоді обрізаємо список задач рядком «…і ще N» (а не посеред задачі).
export function fitCaption(meta: Meta, triaged: TriageItem[] | null, room: number): string {
	const full = formatCaption(meta, triaged);
	if (full.length <= room) return full;
	const lines = (triaged?.length ? formatTriage(triaged) : meta.tasks.map((t) => `• ${t}`).join("\n")).split("\n").filter(Boolean);
	const caption = (summary: string, shown: number) => {
		const parts = [meta.title, summary];
		if (lines.length) {
			const rest = lines.length - shown;
			const more = rest ? [`…і ще ${rest}${triaged?.length ? " у Todoist" : ""}`] : [];
			parts.push(`✅ Задачі:\n${[...lines.slice(0, shown), ...more].join("\n")}`);
		}
		return parts.join("\n\n");
	};
	// Усі задачі з summary, скороченим до того, що лишилось.
	const withoutSummary = caption("", lines.length).length;
	if (room - withoutSummary >= SUMMARY_MIN) return caption(truncate(meta.summary, room - withoutSummary), lines.length);
	// Summary мінімальне, задач — скільки влізе.
	const summary = truncate(meta.summary, SUMMARY_MIN);
	for (let shown = lines.length - 1; shown >= 1; shown--) {
		const c = caption(summary, shown);
		if (c.length <= room) return c;
	}
	return truncate(caption(summary, Math.min(1, lines.length)), room);
}

// Посилання в підписі: назви задач, що вже в Todoist, стають посиланнями на них.
// Шукаємо рядки «• <назва> →» по черзі після заголовка задач; обрізане підписом — без посилання.
// offset/length у UTF-16, як і довжина рядків у JS.
export function taskLinks(caption: string, triaged: TriageItem[] | null, taskIds: Record<string, string>, taskUrl: (id: string) => string): TextLink[] {
	const links: TextLink[] = [];
	let from = caption.indexOf("✅ Задачі:");
	if (from < 0) return links;
	for (const i of triaged ?? []) {
		const id = i.key && !i.duplicateOf ? taskIds[i.key] : undefined;
		if (!id) continue;
		const at = caption.indexOf(`\n• ${i.title} →`, from); // після назви завжди «→ проєкт»
		if (at < 0) continue;
		const offset = at + "\n• ".length;
		links.push({ offset, length: i.title.length, url: taskUrl(id) });
		from = offset + i.title.length;
	}
	return links;
}

export const SUMMARY_MIN = 150; // коротше summary не ріжемо: далі вже скорочуємо список задач

// Хештеги для навігації в каналі: місяць, ISO-тиждень, день (у timeZone) і проєкти нових задач.
export const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

export function hashtags(date: Date, timeZone: string, triaged: TriageItem[] | null): string {
	const [y, m, d] = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date).split("-").map(Number);
	const week = isoWeek(y, m, d);
	const lists = [...new Set((triaged ?? []).filter((i) => !i.duplicateOf && i.project).map((i) => i.project))];
	const day = `${y}_${String(m).padStart(2, "0")}_${String(d).padStart(2, "0")}`;
	return [`#${MONTHS[m - 1]}_${y}`, `#тиждень_${week}`, `#день_${day}`, ...lists.map((l) => `#${l.replace(/[^\p{L}\p{N}_]+/gu, "_")}`)].join(" ");
}

// ISO-тиждень: номер тижня, що містить четвер цього тижня (тижні з понеділка).
export function isoWeek(y: number, m: number, d: number): number {
	const thursday = new Date(Date.UTC(y, m - 1, d));
	thursday.setUTCDate(d + 3 - ((thursday.getUTCDay() + 6) % 7));
	const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
	return Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
}

export function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Рядки задач для підпису. Задачі, що вже в трекері, стають посиланнями (taskLinks).
export function formatTriage(items: TriageItem[]): string {
	return items
		.map((i) => {
			if (i.duplicateOf) return `• ↩️ вже є: ${i.duplicateOf}`;
			const extra = [
				`→ ${i.project || "Inbox"}`,
				i.priority < 4 && `p${i.priority}`,
				...i.labels.map((l) => `@${l}`),
				i.due && `📅 ${i.due.replace("T", " ")}`,
				i.recurrence && `🔁 ${i.recurrenceLabel || i.recurrence}`,
				i.deadline && `⏰ ${i.deadline}`,
				...(i.reminders ?? []).map((r) => (r.startsWith("before:") ? `🔔 −${r.slice(7)} хв` : `🔔 ${r.replace("T", " ")}`)),
			].filter(Boolean);
			return `• ${i.title} ${extra.join(" ")}`;
		})
		.join("\n");
}

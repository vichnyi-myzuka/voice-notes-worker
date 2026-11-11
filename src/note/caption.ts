import type { TgEntity, TgTextLink } from "../telegram";
import { formatTriage, taskUrl, type TriageItem } from "../todoist";
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
	notice = "",
	max = CAPTION_MAX,
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

export function textNote(caption: string, original: string, entities: TgEntity[] = []): { text: string; entities: TgEntity[] } {
	const room = TEXT_MAX - caption.length - 2;
	let cut = room - 1;
	if (/[\uD800-\uDBFF]/.test(original[cut - 1] ?? "")) cut--; // не розрізаємо emoji (сурогатну пару)
	const quote = original.length > room ? `${original.slice(0, cut)}…` : original;
	return {
		text: `${caption}\n\n${quote}`,
		entities: [...entities, { type: "expandable_blockquote", offset: caption.length + 2, length: quote.length }],
	};
}

// Telegram caption_entities: назви задач, що вже в Todoist, стають посиланнями на них.
// Шукаємо рядки «• <назва> →» по черзі після заголовка задач; обрізане підписом — без посилання.
// offset/length у UTF-16, як і довжина рядків у JS.
export function taskLinks(caption: string, triaged: TriageItem[] | null, inTodoist: Record<string, string>) {
	const links: TgTextLink[] = [];
	let from = caption.indexOf("✅ Задачі:");
	if (from < 0) return links;
	for (const i of triaged ?? []) {
		const id = i.key && !i.duplicateOf ? inTodoist[i.key] : undefined;
		if (!id) continue;
		const at = caption.indexOf(`\n• ${i.title} →`, from); // після назви завжди «→ проєкт»
		if (at < 0) continue;
		const offset = at + "\n• ".length;
		links.push({ type: "text_link", offset, length: i.title.length, url: taskUrl(id) });
		from = offset + i.title.length;
	}
	return links;
}

export const CAPTION_MAX = 1024; // ліміт підпису до аудіо в Telegram

export const TEXT_CAPTION_MAX = 3500; // текстова нотатка (ліміт повідомлення 4096): решта — під цитату оригіналу

export const SUMMARY_MIN = 150; // коротше summary не ріжемо: далі вже скорочуємо список задач

// Текстова нотатка: підпис, а під ним оригінальний текст у згорнутій цитаті (як аудіо в голосовій нотатці).
// Ліміт повідомлення Telegram — 4096 символів (UTF-16); довгий оригінал обрізається.
export const TEXT_MAX = 4096;

// Хештеги для навігації в каналі: місяць, ISO-тиждень (у timeZone) і проєкти нових задач.
export const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

export function hashtags(date: Date, timeZone: string, triaged: TriageItem[] | null): string {
	const [y, m, d] = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date).split("-").map(Number);
	const week = isoWeek(y, m, d);
	const lists = [...new Set((triaged ?? []).filter((i) => !i.duplicateOf && i.project).map((i) => i.project))];
	return [`#${MONTHS[m - 1]}_${y}`, `#тиждень_${week}`, ...lists.map((l) => `#${l.replace(/[^\p{L}\p{N}_]+/gu, "_")}`)].join(" ");
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

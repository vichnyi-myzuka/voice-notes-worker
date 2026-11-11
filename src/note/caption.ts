import { formatTriage, taskUrl, type TriageItem } from "../todoist";
import { CAPTION_MAX, SUMMARY_MIN, TEXT_MAX } from "./constants";
import { hashtags } from "./hashtags";
import type { Meta } from "./types";
import { truncate } from "./utils";

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

export function textNote(caption: string, original: string, entities: object[] = []): { text: string; entities: object[] } {
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
	const links: { type: "text_link"; offset: number; length: number; url: string }[] = [];
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

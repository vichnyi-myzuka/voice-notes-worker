import { parseJsonObject } from "./llm";
import { formatTriage, taskValidator, type ThingsSnapshot, type TriageItem } from "./things";

// Чиста логіка нотатки (без I/O): розбір відповідей моделі, підпис, хештеги. Покрита тестами.

export type Meta = { title: string; summary: string; ideas: string[]; tasks: string[]; discard?: "empty" | "cancelled" };

const CAPTION_MAX = 1024;

export function parseMeta(text: string): Meta {
	const json = parseJsonObject(text);
	if (json.discard === "empty" || json.discard === "cancelled") {
		return { title: "", summary: "", ideas: [], tasks: [], discard: json.discard };
	}
	const title = String(json.title ?? "").trim();
	const summary = String(json.summary ?? "").trim();
	if (!title || !summary) throw new Error("empty title/summary");
	const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
	return { title, summary, ideas: list(json.ideas), tasks: list(json.tasks) };
}

// Задачі нотатки без тріажу (немає знімка Things) у форматі TriageItem з ключами t1, t2…
export function plainTasks(tasks: string[]): TriageItem[] {
	return tasks.map((t, i) => ({ title: t, duplicateOf: "", list: "", tags: [], when: "", deadline: "", key: `t${i + 1}` }));
}

// Відповідь моделі редагування: нотатка + задачі з ключами.
// Відомий ключ зберігається (за ним знаходимо задачу в Things), невідомий або повторний — новий ключ.
export function parseEditedNote(
	text: string,
	oldTasks: TriageItem[],
	snap: ThingsSnapshot | null,
): { meta: Meta; triage: TriageItem[] | null } {
	const json = parseJsonObject(text);
	const meta = parseMeta(JSON.stringify({ ...json, tasks: [] }));
	if (meta.discard) return { meta, triage: null };
	const validate = snap ? taskValidator(snap) : null;
	const oldByKey = new Map(oldTasks.map((t) => [t.key, t]));
	let nextKey = Math.max(0, ...oldTasks.map((t) => Number(t.key?.slice(1)) || 0)) + 1;
	const used = new Set<string>();
	const items = (Array.isArray(json.tasks) ? json.tasks : []).map((r: Record<string, unknown>): TriageItem => {
		let key = String(r.key ?? "");
		if (!oldByKey.has(key) || used.has(key)) key = `t${nextKey++}`;
		used.add(key);
		const base = validate
			? validate(r)
			: { title: String(r.title ?? "").trim(), duplicateOf: "", list: "", tags: [], when: "", deadline: "" };
		// Дублікат лишається дублікатом, якщо це та сама задача (за ключем).
		return { ...base, duplicateOf: oldByKey.get(key)?.duplicateOf ?? "", key };
	});
	const valid = items.filter((i) => i.title);
	meta.tasks = valid.map((i) => i.title);
	return { meta, triage: snap ? valid : null };
}

// Підпис до аудіо: назва, summary і (якщо є) списки думок і задач.
// Якщо був тріаж, задачі показуються з проєктом, тегами, датами й позначкою дублікатів.
export function formatCaption({ title, summary, ideas, tasks }: Meta, triaged: TriageItem[] | null, inThings?: Set<string>): string {
	const parts = [title, summary];
	if (ideas.length) parts.push(`💡 Ключові думки:\n${ideas.map((i) => `• ${i}`).join("\n")}`);
	if (triaged?.length) parts.push(`✅ Задачі:\n${formatTriage(triaged, inThings)}`);
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
	inThings?: Set<string>, // ключі задач, які вже в Things (☑️)
): string {
	const tail = [notice, hashtags(new Date(ts), timeZone, triaged)].filter(Boolean).join("\n\n");
	return `${truncate(formatCaption(meta, triaged, inThings), CAPTION_MAX - tail.length - 2)}\n\n${tail}`;
}

// Хештеги для навігації в каналі: місяць, ISO-тиждень (у timeZone) і області нових задач.
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

export function hashtags(date: Date, timeZone: string, triaged: TriageItem[] | null): string {
	const [y, m, d] = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date).split("-").map(Number);
	const week = isoWeek(y, m, d);
	const lists = [...new Set((triaged ?? []).filter((i) => !i.duplicateOf && i.list).map((i) => i.list))];
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

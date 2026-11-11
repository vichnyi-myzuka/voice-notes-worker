import { parseJsonObject } from "../../infrastructure/llm";
import type { TriageItem } from "../../infrastructure/todoist";
import type { Meta } from "./types";

export function parseMeta(text: string): Meta {
	const json = parseJsonObject(text);
	if (json.discard === "empty" || json.discard === "cancelled" || json.discard === "delete") {
		return { title: "", summary: "", ideas: [], tasks: [], discard: json.discard };
	}
	const title = String(json.title ?? "").trim();
	const summary = String(json.summary ?? "").trim();
	if (!title || !summary) throw new Error("empty title/summary");
	const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
	return { title, summary, ideas: list(json.ideas), tasks: list(json.tasks) };
}

export const emptyFields = { title: "", duplicateOf: "", project: "", labels: [], priority: 4, due: "", deadline: "" };

// Задачі нотатки без тріажу (немає Todoist) у форматі TriageItem з ключами t1, t2…
export function plainTasks(tasks: string[]): TriageItem[] {
	return tasks.map((t, i) => ({ ...emptyFields, title: t, key: `t${i + 1}` }));
}

// Відповідь моделі редагування: нотатка + задачі з ключами.
// Відомий ключ зберігається (за ним знаходимо задачу в Todoist), невідомий або повторний — новий ключ.
// validate: перевірка полів Todoist (null — тріажу немає, лише назви задач).
export function parseEditedNote(
	text: string,
	oldTasks: TriageItem[],
	validate: ((r: Record<string, unknown>) => TriageItem) | null,
): { meta: Meta; triage: TriageItem[] | null } {
	const json = parseJsonObject(text);
	const meta = parseMeta(JSON.stringify({ ...json, tasks: [] }));
	if (meta.discard) return { meta, triage: null };
	const oldByKey = new Map(oldTasks.map((t) => [t.key, t]));
	let nextKey = Math.max(0, ...oldTasks.map((t) => Number(t.key?.slice(1)) || 0)) + 1;
	const used = new Set<string>();
	const items = (Array.isArray(json.tasks) ? json.tasks : []).map((r: Record<string, unknown>): TriageItem => {
		let key = String(r.key ?? "");
		if (!oldByKey.has(key) || used.has(key)) key = `t${nextKey++}`;
		used.add(key);
		const base = validate ? validate(r) : { ...emptyFields, title: String(r.title ?? "").trim() };
		// Дублікат лишається дублікатом, якщо це та сама задача (за ключем).
		return { ...base, duplicateOf: oldByKey.get(key)?.duplicateOf ?? "", key };
	});
	const valid = items.filter((i) => i.title);
	meta.tasks = valid.map((i) => i.title);
	return { meta, triage: validate ? valid : null };
}

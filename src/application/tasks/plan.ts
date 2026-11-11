import type { Env } from "../../infrastructure/env";
import type { TaskOp, TrackedTasks, TriageItem } from "../../domain/tracker";

export const sameItem = (a: TriageItem, b: TriageItem) =>
	a.title === b.title &&
	a.project === b.project &&
	[...a.labels].sort().join() === [...b.labels].sort().join() &&
	a.priority === b.priority &&
	a.due === b.due &&
	a.deadline === b.deadline &&
	(a.recurrence ?? "") === (b.recurrence ?? "") &&
	(a.details ?? "") === (b.details ?? "") &&
	sameReminders(a, b);

export const sameReminders = (a: TriageItem, b: TriageItem) => [...(a.reminders ?? [])].sort().join() === [...(b.reminders ?? [])].sort().join();

// Що зробити в Todoist: змінені задачі оновити, нові створити, прибрані видалити.
// Дублікати існуючих задач не створюємо; незмінені задачі пропускаємо.
export function planOps(items: TriageItem[], tracked: TrackedTasks): TaskOp[] {
	const ops: TaskOp[] = [];
	const kept = new Set<string>();
	for (const item of items) {
		const { key } = item;
		const prev = key ? tracked[key] : undefined;
		if (key && prev) {
			kept.add(key);
			if (!sameItem(prev.item, item)) {
				ops.push({
					key,
					item,
					id: prev.id,
					...(prev.item.project !== item.project && { move: true }),
					...(!sameReminders(prev.item, item) && { reminders: true, oldReminderIds: prev.reminderIds ?? [] }),
					...((prev.item.details ?? "") !== (item.details ?? "") && { describe: true }),
				});
			}
		} else if (!item.duplicateOf) {
			ops.push({ key: item.key ?? "", item });
		}
	}
	for (const [key, prev] of Object.entries(tracked)) {
		if (!kept.has(key)) ops.push({ key, item: null, id: prev.id });
	}
	return ops;
}

export const trackedTasksKey = (noteId: string) => `notes/${noteId}.tasks.json`;

// До перейменування ключ мав назву трекера: нотатки, створені раніше (живуть 7 днів), читаємо за старим.
// TODO: прибрати fallback, коли всі такі нотатки застаріють.
const legacyKey = (noteId: string) => `notes/${noteId}.todoist.json`;

export async function getTrackedTasks(env: Env, noteId: string): Promise<TrackedTasks> {
	const stored = (await env.BUCKET.get(trackedTasksKey(noteId))) ?? (await env.BUCKET.get(legacyKey(noteId)));
	return (await stored?.json<TrackedTasks>()) ?? {};
}

// Підпис показує повтор лише тих задач, які в Todoist справді з повтором.
export function withAppliedRecurrence(items: TriageItem[] | null, tracked: TrackedTasks): TriageItem[] | null {
	return (
		items?.map((i) => {
			const applied = i.key ? tracked[i.key] : undefined;
			return i.recurrence && applied && !applied.item.recurrence ? { ...i, recurrence: "", recurrenceLabel: "" } : i;
		}) ?? null
	);
}

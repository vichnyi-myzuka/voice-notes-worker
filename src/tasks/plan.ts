import type { TriageItem } from "../todoist";
import type { InTodoist, TodoistOp } from "./types";

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
export function planOps(items: TriageItem[], inTodoist: InTodoist): TodoistOp[] {
	const ops: TodoistOp[] = [];
	const kept = new Set<string>();
	for (const item of items) {
		const prev = item.key ? inTodoist[item.key] : undefined;
		if (prev) {
			kept.add(item.key!);
			if (!sameItem(prev.item, item)) {
				ops.push({
					key: item.key!,
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
	for (const [key, prev] of Object.entries(inTodoist)) {
		if (!kept.has(key)) ops.push({ key, item: null, id: prev.id });
	}
	return ops;
}

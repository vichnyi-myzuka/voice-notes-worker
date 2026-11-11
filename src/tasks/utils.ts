import type { TriageItem } from "../todoist";
import type { InTodoist } from "./types";

// Підпис показує повтор лише тих задач, які в Todoist справді з повтором.
export function withAppliedRecurrence(items: TriageItem[] | null, inTodoist: InTodoist): TriageItem[] | null {
	return (
		items?.map((i) => {
			const applied = i.key ? inTodoist[i.key] : undefined;
			return i.recurrence && applied && !applied.item.recurrence ? { ...i, recurrence: "", recurrenceLabel: "" } : i;
		}) ?? null
	);
}

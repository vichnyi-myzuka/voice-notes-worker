import type { TriageItem } from "./types";

// Посилання на задачу в Todoist (веб і застосунки).
export const taskUrl = (id: string) => `https://app.todoist.com/app/task/${id}`;

// Рядки задач для підпису в Telegram. Задачі, що вже в Todoist, стають посиланнями (note.ts → taskLinks).
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

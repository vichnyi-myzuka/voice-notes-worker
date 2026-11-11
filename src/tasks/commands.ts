import type { TodoistSnapshot, TriageItem } from "../todoist";
import type { TodoistOp } from "./types";

// Команди /sync для операцій. uuid сталий для дії й операції: повторне натискання
// чи ретрай не виконає команду вдруге (Todoist ігнорує повторний uuid).
export function buildCommands(actionId: string, ops: TodoistOp[], description: string, snap: TodoistSnapshot): object[] {
	// Опис задачі: подробиці з запису, під ними — посилання на нотатку.
	const describe = (i: TriageItem) => (i.details ? `${i.details}\n\n${description}` : description);
	const projectId = (name: string) => snap.projects.find((p) => (name ? p.name === name : p.inbox))?.id;
	const fields = (i: TriageItem) => ({
		content: i.title,
		labels: i.labels,
		priority: 5 - i.priority, // в API 4 — це p1
		// Повтор — фразою (Todoist сам рахує дати); інакше дата, з часом — «плаваючий» час (без поясу).
		due: i.recurrence
			? { string: i.recurrence, lang: "en" }
			: i.due
				? { date: i.due.includes("T") ? `${i.due}:00` : i.due }
				: null,
		deadline: i.deadline ? { date: i.deadline } : null,
	});
	return ops.flatMap((op, n) => {
		const uuid = (suffix = "") => `${actionId}-${n}${suffix}`;
		// Нагадування задачі (item_id може бути temp_id щойно створеної задачі в цьому ж пакеті).
		const addReminders = (itemId: string, item: TriageItem) =>
			(item.reminders ?? []).map((r, j) => ({
				type: "reminder_add",
				uuid: uuid(`r${j}`),
				temp_id: `tmp-${actionId}-${n}r${j}`,
				args: r.startsWith("before:")
					? { item_id: itemId, type: "relative", minute_offset: Number(r.slice(7)) }
					: { item_id: itemId, type: "absolute", due: { date: `${r}:00` } },
			}));
		if (!op.id) {
			const { due, deadline, ...rest } = fields(op.item!);
			const project_id = op.item!.project ? projectId(op.item!.project) : undefined;
			const temp_id = `tmp-${actionId}-${n}`;
			return [
				{
					type: "item_add",
					uuid: uuid(),
					temp_id,
					args: { ...rest, description: describe(op.item!), ...(project_id && { project_id }), ...(due && { due }), ...(deadline && { deadline }) },
				},
				...addReminders(temp_id, op.item!),
			];
		}
		if (!op.item) return [{ type: "item_delete", uuid: uuid(), args: { id: op.id } }];
		// Опис переписуємо лише коли змінились подробиці: інакше не чіпаємо те, що автор дописав у Todoist сам.
		const cmds: object[] = [
			{ type: "item_update", uuid: uuid(), args: { id: op.id, ...fields(op.item), ...(op.describe && { description: describe(op.item) }) } },
		];
		// Проєкт могли перейменувати чи видалити після тріажу: тоді задачу не переміщуємо.
		const target = op.move ? projectId(op.item.project) : undefined;
		if (target) cmds.push({ type: "item_move", uuid: uuid("m"), args: { id: op.id, project_id: target } });
		if (op.reminders) {
			(op.oldReminderIds ?? []).forEach((id, k) => cmds.push({ type: "reminder_delete", uuid: uuid(`rd${k}`), args: { id } }));
			cmds.push(...addReminders(op.id, op.item));
		}
		return cmds;
	});
}

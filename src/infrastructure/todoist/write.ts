import type { ApplyResult, SetupPlan, TaskOp, TrackerSnapshot, TriageItem } from "../../domain/tracker";
import type { Env } from "../env";
import { fetchSnapshot, readResources, runCommands } from "./api";
import { rejected, type CommandStatus, type Json, type TodoistCommand } from "./types";

// Повтор, якого Todoist не розпізнав.
const invalidDate = (status: CommandStatus | undefined) => typeof status === "object" && status.error_tag === "INVALID_DATE";

// Команди /sync для операцій. uuid сталий для дії й операції: ретрай не виконає команду вдруге
// (Todoist ігнорує повторний uuid).
export function buildCommands(actionId: string, ops: TaskOp[], description: string, snap: TrackerSnapshot): TodoistCommand[] {
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
	return ops.flatMap((op, n): TodoistCommand[] => {
		const uuid = (suffix = "") => `${actionId}-${n}${suffix}`;
		// Нагадування задачі (item_id може бути temp_id щойно створеної задачі в цьому ж пакеті).
		const addReminders = (itemId: string, item: TriageItem): TodoistCommand[] =>
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
		const cmds: TodoistCommand[] = [
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

// Виконує операції. Повтор, якого Todoist не розпізнав (INVALID_DATE), відхиляє всю команду: такі задачі
// пробуємо ще раз без повтору (з датою першого виконання).
export async function applyOps(env: Env, id: string, planned: TaskOp[], description: string): Promise<ApplyResult> {
	const snap = await fetchSnapshot(env);
	const res = await runCommands(env, buildCommands(id, planned, description, snap));

	const prefix = planned.map(() => id);
	const ops = [...planned];
	const bad = planned.flatMap((op, n) => (op.item?.recurrence && invalidDate(res.sync_status[`${id}-${n}`]) ? [n] : []));
	if (bad.length) {
		const retryId = `${id}x`;
		bad.forEach((n) => {
			ops[n] = { ...ops[n], item: { ...ops[n].item!, recurrence: "", recurrenceLabel: "" } };
			prefix[n] = retryId;
			// Статуси задачі й залежних команд (нагадування, переміщення): їх замінять статуси повтору.
			const own = new RegExp(`^${id}-${n}(?:[a-z]|$)`);
			for (const k of Object.keys(res.sync_status)) if (own.test(k)) delete res.sync_status[k];
			console.error(`todoist: recurrence "${planned[n].item!.recurrence}" not recognized, task "${planned[n].item!.title}" saved without it`);
		});
		const mine = (c: TodoistCommand) => bad.some((n) => new RegExp(`^${retryId}-${n}(?:[a-z]|$)`).test(c.uuid));
		const retry = await runCommands(env, buildCommands(retryId, ops, description, snap).filter(mine));
		Object.assign(res.sync_status, retry.sync_status);
		Object.assign(res.temp_id_mapping, retry.temp_id_mapping);
	}

	const results = ops.map((op, n) => {
		const p = prefix[n];
		const taskId = op.id ?? res.temp_id_mapping[`tmp-${p}-${n}`];
		// ID нових нагадувань — з temp_id_mapping; якщо нагадування не змінювались, їхні id лишаються.
		const reminderIds = !op.id || op.reminders ? (op.item?.reminders ?? []).map((_, j) => res.temp_id_mapping[`tmp-${p}-${n}r${j}`]).filter(Boolean) : undefined;
		return { ok: res.sync_status[`${p}-${n}`] === "ok", item: op.item, ...(taskId && { id: taskId }), ...(reminderIds && { reminderIds }) };
	});
	return { results, errors: rejected(res.sync_status) };
}

// Фото з нотатки — коментарем-вкладенням до задач. Повтор безпечний: коментарі мають сталі uuid
// (повторне завантаження файлу лише лишить зайвий upload).
export async function attachFile(env: Env, id: string, taskIds: string[], file: Blob, fileName: string): Promise<void> {
	if (!taskIds.length) return;
	const form = new FormData();
	form.append("file", file, fileName);
	const res = await fetch("https://api.todoist.com/api/v1/uploads", {
		method: "POST",
		headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` },
		body: form,
	});
	if (!res.ok) throw new Error(`Todoist uploads ${res.status}: ${await res.text()}`);
	const upload = await res.json<Json>();
	const commands = taskIds.map((item_id, n) => ({
		type: "note_add",
		uuid: `${id}-a${n}`,
		temp_id: `tmp-${id}-a${n}`,
		args: { item_id, content: "📷 Фото з нотатки", file_attachment: upload },
	}));
	const errors = rejected((await runCommands(env, commands)).sync_status);
	if (errors.length) throw new Error(`Todoist note_add: ${JSON.stringify(errors)}`);
}

// Видаляє задачі, які ще відкриті (виконані лишаються в історії Todoist). Повертає кількість видалених.
export async function deleteOpenTasks(env: Env, ids: string[]): Promise<number> {
	if (!env.TODOIST_TOKEN || !ids.length) return 0;
	const d = await readResources<{ items: { id: string; checked?: boolean; is_deleted?: boolean }[] }>(env, ["items"]);
	const open = new Set(d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.id));
	const commands = ids.filter((id) => open.has(id)).map((id) => ({ type: "item_delete", uuid: `delete-${id}`, args: { id } }));
	if (!commands.length) return 0;
	const errors = rejected((await runCommands(env, commands)).sync_status);
	if (errors.length) throw new Error(`Todoist delete failed: ${JSON.stringify(errors)}`);
	return commands.length;
}

// Команди налаштування. uuid сталі (id плану + номер), тож ретрай не виконає їх вдруге.
export function setupCommands(id: string, plan: SetupPlan): TodoistCommand[] {
	const cmds = plan.changes.flatMap((c, i): TodoistCommand[] => {
		const uuid = `${id}-s${i}`;
		const desc = c.description ? { description: c.description } : {};
		if (c.kind === "project") {
			if (c.action === "create") return [{ type: "project_add", uuid, temp_id: `tmp-${uuid}`, args: { name: c.name, ...desc } }];
			if (c.action === "rename") return [{ type: "project_update", uuid, args: { id: c.id ?? "", name: c.newName, ...desc } }];
			if (c.action === "describe") return [{ type: "project_update", uuid, args: { id: c.id ?? "", description: c.description } }];
			// Проєкт з відкритими задачами не видаляємо (зникли б і задачі), а архівуємо: його можна повернути.
			return [{ type: c.openTasks ? "project_archive" : "project_delete", uuid, args: { id: c.id ?? "" } }];
		}
		if (c.action === "create") return [{ type: "label_add", uuid, temp_id: `tmp-${uuid}`, args: { name: c.name } }];
		if (c.action === "rename") return [{ type: "label_update", uuid, args: { id: c.id ?? "", name: c.newName } }];
		if (c.action === "delete") return [{ type: "label_delete", uuid, args: { id: c.id ?? "" } }]; // знімає мітку з задач
		return []; // опис мітки живе лише в правилах
	});
	if (plan.rules) cmds.push({ type: "project_update", uuid: `${id}-rules`, args: { id: plan.rules.projectId, description: plan.rules.text } });
	return cmds;
}

export async function applySetup(env: Env, id: string, plan: SetupPlan): Promise<void> {
	const commands = setupCommands(id, plan);
	if (!commands.length) return;
	const errors = rejected((await runCommands(env, commands)).sync_status);
	if (errors.length) throw new Error(`Todoist setup failed: ${JSON.stringify(errors)}`);
}

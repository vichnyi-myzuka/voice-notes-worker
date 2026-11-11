import type { Env } from "./index";
import type { Steps } from "./steps";
import { fetchSnapshot, sync, type TodoistSnapshot, type TriageItem } from "./todoist";

// Задачі нотатки в Todoist: що вже створено (InTodoist), план змін, команди /sync, виконання.

// Що з нотатки вже є в Todoist (за ключем задачі).
export type InTodoist = Record<string, { id: string; item: TriageItem; reminderIds?: string[] }>;
// Без id — створити; з id і item — оновити (move: змінився проєкт; reminders: перестворити нагадування,
// oldReminderIds — що видалити; describe: змінились подробиці, переписати опис); з id без item — видалити.
export type TodoistOp = {
	key: string;
	item: TriageItem | null;
	id?: string;
	move?: boolean;
	reminders?: boolean;
	oldReminderIds?: string[];
	describe?: boolean;
};

const inTodoistKey = (noteId: string) => `notes/${noteId}.todoist.json`;

export async function getInTodoist(env: Env, noteId: string): Promise<InTodoist> {
	return (await (await env.BUCKET.get(inTodoistKey(noteId)))?.json<InTodoist>()) ?? {};
}

const sameItem = (a: TriageItem, b: TriageItem) =>
	a.title === b.title &&
	a.project === b.project &&
	[...a.labels].sort().join() === [...b.labels].sort().join() &&
	a.priority === b.priority &&
	a.due === b.due &&
	a.deadline === b.deadline &&
	(a.recurrence ?? "") === (b.recurrence ?? "") &&
	(a.details ?? "") === (b.details ?? "") &&
	sameReminders(a, b);
const sameReminders = (a: TriageItem, b: TriageItem) => [...(a.reminders ?? [])].sort().join() === [...(b.reminders ?? [])].sort().join();

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
	const upload = await res.json();
	const commands = taskIds.map((item_id, n) => ({
		type: "note_add",
		uuid: `${id}-a${n}`,
		temp_id: `tmp-${id}-a${n}`,
		args: { item_id, content: "📷 Фото з нотатки", file_attachment: upload },
	}));
	const status = ((await sync(env, { commands: JSON.stringify(commands) })) as { sync_status: Record<string, unknown> }).sync_status;
	const errors = Object.values(status).filter((s) => s !== "ok");
	if (errors.length) throw new Error(`Todoist note_add: ${JSON.stringify(errors)}`);
}

// Виконує операції в Todoist і оновлює стан задач нотатки (InTodoist).
// Команди мають сталі uuid (runId + номер операції), тож ретрай не виконає їх удруге.
export type ApplyParams = { noteId: string; runId: string; ops: TodoistOp[]; description: string; messageUrl?: string };

export async function applyOps(env: Env, { noteId, runId: id, ops: planned, description: text, messageUrl }: ApplyParams): Promise<true> {
	const snap = await fetchSnapshot(env);
	const description = messageUrl ? `${text}\n${messageUrl}` : text;
	type SyncResult = { sync_status: Record<string, unknown>; temp_id_mapping: Record<string, string> };
	const run = async (commands: object[]) => (await sync(env, { commands: JSON.stringify(commands) })) as SyncResult;
	const res = await run(buildCommands(id, planned, description, snap));

	// Повтор, якого Todoist не розпізнав (INVALID_DATE), відхиляє всю команду: такі задачі пробуємо ще раз без повтору
	// (з датою першого виконання). В InTodoist вони потрапляють без повтору, тож підпис не покаже 🔁.
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
		const mine = (c: object) => bad.some((n) => new RegExp(`^${retryId}-${n}(?:[a-z]|$)`).test((c as { uuid: string }).uuid));
		const retry = await run(buildCommands(retryId, ops, description, snap).filter(mine));
		Object.assign(res.sync_status, retry.sync_status);
		Object.assign(res.temp_id_mapping, retry.temp_id_mapping);
	}
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");

	// Стан оновлюємо і для успішних команд при частковому збої: інакше ID створених задач загубляться.
	// Повтор безпечний: Todoist не виконує команду з тим самим uuid вдруге.
	const state = await getInTodoist(env, noteId);
	ops.forEach((op, n) => {
		const p = prefix[n];
		if (res.sync_status[`${p}-${n}`] !== "ok") return;
		if (!op.item) delete state[op.key];
		else {
			const taskId = op.id ?? res.temp_id_mapping[`tmp-${p}-${n}`];
			// ID нагадувань: нові — з temp_id_mapping, інакше лишаються попередні.
			const reminderIds =
				!op.id || op.reminders
					? (op.item.reminders ?? []).map((_, j) => res.temp_id_mapping[`tmp-${p}-${n}r${j}`]).filter(Boolean)
					: state[op.key]?.reminderIds;
			if (taskId) state[op.key] = { id: taskId, item: op.item, ...(reminderIds?.length && { reminderIds }) };
		}
	});
	await env.BUCKET.put(inTodoistKey(noteId), JSON.stringify(state));
	if (errors.length) throw new Error(`Todoist commands failed: ${JSON.stringify(errors)}`);
	return true;
}

// Задачі нотатки в Todoist: план змін (ops) → виконання. Кроки зберігаються в стані обробки:
// ops фіксуються раз (uuid команд не змінюються при ретраї), actionId — id запуску, todoistApplied — результат.
// Повертає undefined, якщо змін немає; false — не вдалося навіть на останній спробі (нотатка все одно дійде).
export type SyncState = { ops?: TodoistOp[]; actionId?: string; todoistApplied?: boolean };

export async function syncTasks<S extends SyncState>(
	env: Env,
	steps: Steps<S>,
	{ noteId, items, description, messageUrl }: { noteId: string; items: TriageItem[] | null; description: string; messageUrl?: string | null },
): Promise<boolean | undefined> {
	// Steps<S> типізовано під конкретний стан: тут потрібні лише поля SyncState.
	const run = steps as unknown as Steps<SyncState>;
	const ops = await run.step("ops", async () => (items ? planOps(items, await getInTodoist(env, noteId)) : []));
	if (!ops.length) return undefined;
	const runId = await run.step("actionId", async () => crypto.randomUUID());
	return run.step(
		"todoistApplied",
		async () => {
			const applied = await applyOps(env, { noteId, runId, ops, description, ...(messageUrl && { messageUrl }) });
			console.log(`todoist ${runId} applied: ${ops.length} ops`);
			return applied;
		},
		{ onFinalFailure: () => false },
	);
}
const invalidDate = (status: unknown) => (status as { error_tag?: string } | undefined)?.error_tag === "INVALID_DATE";

// Підпис показує повтор лише тих задач, які в Todoist справді з повтором.
export function withAppliedRecurrence(items: TriageItem[] | null, inTodoist: InTodoist): TriageItem[] | null {
	return (
		items?.map((i) => {
			const applied = i.key ? inTodoist[i.key] : undefined;
			return i.recurrence && applied && !applied.item.recurrence ? { ...i, recurrence: "", recurrenceLabel: "" } : i;
		}) ?? null
	);
}

// Видаляє задачі, які ще відкриті (виконані лишаються в історії Todoist). Повертає кількість видалених.
export async function deleteOpenTasks(env: Env, ids: string[]): Promise<number> {
	if (!ids.length) return 0;
	const d = (await sync(env, { sync_token: "*", resource_types: JSON.stringify(["items"]) })) as {
		items: { id: string; checked?: boolean; is_deleted?: boolean }[];
	};
	const open = new Set(d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.id));
	const commands = ids.filter((id) => open.has(id)).map((id) => ({ type: "item_delete", uuid: `delete-${id}`, args: { id } }));
	if (!commands.length) return 0;
	const res = (await sync(env, { commands: JSON.stringify(commands) })) as { sync_status: Record<string, unknown> };
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");
	if (errors.length) throw new Error(`Todoist delete failed: ${JSON.stringify(errors)}`);
	return commands.length;
}


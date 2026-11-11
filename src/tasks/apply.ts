import type { Env } from "../env";
import { fetchSnapshot, sync } from "../todoist";
import { buildCommands } from "./commands";
import { getInTodoist, inTodoistKey } from "./ledger";
import type { ApplyParams } from "./types";

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

export const invalidDate = (status: unknown) => (status as { error_tag?: string } | undefined)?.error_tag === "INVALID_DATE";

import type { TaskTracker } from "../../domain/tracker";
import type { Env } from "../../infrastructure/env";
import { getTrackedTasks, trackedTasksKey } from "./plan";
import type { ApplyParams } from "./types";

// Виконує операції в трекері й оновлює стан задач нотатки.
export async function applyOps(env: Env, tracker: TaskTracker, { noteId, runId, ops, description: text, messageUrl }: ApplyParams): Promise<true> {
	const description = messageUrl ? `${text}\n${messageUrl}` : text;
	const { results, errors } = await tracker.applyOps(runId, ops, description);

	// Стан оновлюємо і для успішних операцій при частковому збої: інакше ID створених задач загубляться.
	// Повтор безпечний: трекер не виконує команду з тим самим id вдруге.
	// Повтор, якого трекер не розпізнав, у результаті вже прибрано: підпис не покаже 🔁.
	const tracked = await getTrackedTasks(env, noteId);
	ops.forEach((op, n) => {
		const result = results[n];
		if (!result.ok) return;
		if (!op.item) delete tracked[op.key];
		else if (result.id) {
			const reminderIds = result.reminderIds ?? tracked[op.key]?.reminderIds;
			tracked[op.key] = { id: result.id, item: result.item ?? op.item, ...(reminderIds?.length && { reminderIds }) };
		}
	});
	await env.BUCKET.put(trackedTasksKey(noteId), JSON.stringify(tracked));
	if (errors.length) throw new Error(`Task tracker commands failed: ${JSON.stringify(errors)}`);
	return true;
}

import type { Env } from "../../infrastructure/env";
import type { Steps } from "../../infrastructure/steps";
import type { TaskTracker, TriageItem } from "../../domain/tracker";
import { applyOps } from "./apply";
import { getTrackedTasks } from "./plan";
import { planOps } from "./plan";
import type { SyncState } from "./types";

export async function syncTasks(
	env: Env,
	tracker: TaskTracker,
	run: Steps<SyncState>,
	{ noteId, items, description, messageUrl }: { noteId: string; items: TriageItem[] | null; description: string; messageUrl?: string | null },
): Promise<boolean | undefined> {
	const ops = await run.step("ops", async () => (items ? planOps(items, await getTrackedTasks(env, noteId)) : []));
	if (!ops.length) return undefined;
	const runId = await run.step("actionId", async () => crypto.randomUUID());
	return run.step(
		"tasksApplied",
		async () => {
			const applied = await applyOps(env, tracker, { noteId, runId, ops, description, ...(messageUrl && { messageUrl }) });
			console.log(`tasks ${runId} applied: ${ops.length} ops`);
			return applied;
		},
		{ onFinalFailure: () => false },
	);
}

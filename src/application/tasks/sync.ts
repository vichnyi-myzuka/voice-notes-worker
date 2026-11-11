import type { Env } from "../../infrastructure/env";
import type { Steps } from "../../infrastructure/steps";
import type { TriageItem } from "../../infrastructure/todoist";
import { applyOps } from "./apply";
import { getInTodoist } from "./plan";
import { planOps } from "./plan";
import type { SyncState } from "./types";

export async function syncTasks(
	env: Env,
	run: Steps<SyncState>,
	{ noteId, items, description, messageUrl }: { noteId: string; items: TriageItem[] | null; description: string; messageUrl?: string | null },
): Promise<boolean | undefined> {
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

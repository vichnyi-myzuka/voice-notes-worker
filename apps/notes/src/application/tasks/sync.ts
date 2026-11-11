import type { Steps } from "../../infrastructure/steps";
import type { TriageItem } from "../../domain/tracker";
import { applyOps } from "./apply";
import { planOps } from "./plan";
import type { SyncState, TaskPorts } from "./types";

export async function syncTasks(
	ports: TaskPorts,
	run: Steps<SyncState>,
	{ noteId, items, description, messageUrl }: { noteId: string; items: TriageItem[] | null; description: string; messageUrl?: string | null },
): Promise<boolean | undefined> {
	const ops = await run.step("ops", async () => (items ? planOps(items, await ports.ledger.get(noteId)) : []));
	if (!ops.length) return undefined;
	const runId = await run.step("actionId", async () => crypto.randomUUID());
	return run.step(
		"tasksApplied",
		async () => {
			const applied = await applyOps(ports, { noteId, runId, ops, description, ...(messageUrl && { messageUrl }) });
			console.log(`tasks ${runId} applied: ${ops.length} ops`);
			return applied;
		},
		{ onFinalFailure: () => false },
	);
}

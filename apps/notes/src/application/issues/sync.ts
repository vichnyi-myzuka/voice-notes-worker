import type { Steps } from "@voice-notes/core";
import type { Llm } from "@voice-notes/core";
import type { TriageItem } from "../../domain/tracker";
import { applyIssueOps } from "./apply";
import { classifyIssues } from "./classify";
import { planIssueOps } from "./plan";
import type { IssuePorts, IssueState } from "./types";

// Задачі нотатки, що є роботою над проєктом, — також issues у GitHub (на додачу до Todoist).
// Повертає undefined, якщо змін немає або GitHub вимкнено; false — не вдалося навіть на останній спробі.
export async function syncIssues(
	ports: IssuePorts & { llm: Llm },
	run: Steps<IssueState>,
	{ noteId, items, description, messageUrl }: { noteId: string; items: TriageItem[] | null; description: string; messageUrl?: string | null },
): Promise<boolean | undefined> {
	const { issues, issueLedger, llm } = ports;
	if (!issues.enabled || !items) return undefined;
	const tracked = await issueLedger.get(noteId);
	// Модель вирішує лише для нових задач: репозиторій уже створеної issue не змінюється.
	const fresh = items.filter((i) => i.key && !i.duplicateOf && !tracked[i.key]);
	const repos = await run.step(
		"issueRepos",
		async () => {
			if (!fresh.length) return {};
			const found = await classifyIssues(llm, fresh, issues.repos);
			if (!found) throw new Error("All issue classification models failed");
			return found;
		},
		{ onFinalFailure: () => ({}) },
	);
	const ops = planIssueOps(items, tracked, repos);
	if (!ops.length) return undefined;
	return run.step(
		"issuesApplied",
		async () => {
			const applied = await applyIssueOps(ports, { noteId, ops, description, messageUrl });
			console.log(`issues applied: ${ops.length} ops`);
			return applied;
		},
		{ onFinalFailure: () => false },
	);
}

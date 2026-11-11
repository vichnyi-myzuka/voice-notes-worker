import type { IssueOp, TrackedIssues } from "../../domain/issues";
import type { TriageItem } from "../../domain/tracker";

// Що зробити в GitHub: нові задачі проєкту — створити, змінені — оновити, прибрані з нотатки — закрити.
// Дублікати задач Todoist не створюємо; репозиторій уже створеної issue не змінюється.
export function planIssueOps(items: TriageItem[], tracked: TrackedIssues, repos: Record<string, string>): IssueOp[] {
	const ops: IssueOp[] = [];
	const kept = new Set<string>();
	for (const { key, title, details = "", duplicateOf } of items) {
		if (!key) continue;
		const prev = tracked[key];
		if (prev) {
			kept.add(key);
			if (prev.title !== title || prev.details !== details) ops.push({ kind: "update", key, title, details });
		} else if (repos[key] && !duplicateOf) {
			ops.push({ kind: "create", key, repo: repos[key], title, details });
		}
	}
	for (const key of Object.keys(tracked)) if (!kept.has(key)) ops.push({ kind: "close", key });
	return ops;
}

import type { IssueOp } from "../../domain/issues";
import type { IssuePorts } from "./types";

// Тіло issue: подробиці з запису й посилання на нотатку.
export const issueBody = (details: string, description: string, messageUrl?: string | null) =>
	[details, `🎙 ${description}`, messageUrl].filter(Boolean).join("\n\n");

export const CLOSE_REMOVED = "Задачу прибрано з нотатки.";
export const CLOSE_DELETED = "Нотатку видалено.";

// Виконує операції по черзі й після кожної зберігає книгу: якщо далі збій, створені issues не загубляться
// (повторна спроба побачить їх у книзі й не створить удруге). Збій однієї операції не блокує решту.
export async function applyIssueOps(
	{ issues, issueLedger }: IssuePorts,
	{ noteId, ops, description, messageUrl }: { noteId: string; ops: IssueOp[]; description: string; messageUrl?: string | null },
): Promise<true> {
	const tracked = await issueLedger.get(noteId);
	const errors: string[] = [];
	for (const op of ops) {
		try {
			if (op.kind === "create") {
				const { number, url } = await issues.create(op.repo, { title: op.title, body: issueBody(op.details, description, messageUrl) });
				tracked[op.key] = { repo: op.repo, number, url, title: op.title, details: op.details };
			} else if (op.kind === "update") {
				const prev = tracked[op.key];
				await issues.update(prev.repo, prev.number, { title: op.title, body: issueBody(op.details, description, messageUrl) });
				tracked[op.key] = { ...prev, title: op.title, details: op.details };
			} else {
				const prev = tracked[op.key];
				await issues.close(prev.repo, prev.number, CLOSE_REMOVED);
				delete tracked[op.key];
			}
			await issueLedger.save(noteId, tracked);
		} catch (err) {
			errors.push(`${op.kind} ${op.key}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (errors.length) throw new Error(`GitHub issues failed: ${errors.join("; ")}`);
	return true;
}

// Нотатку видалено: закриваємо всі її issues і чистимо книгу.
export async function closeIssues({ issues, issueLedger }: IssuePorts, noteId: string): Promise<number> {
	const tracked = await issueLedger.get(noteId);
	const total = Object.keys(tracked).length;
	for (const [key, t] of Object.entries(tracked)) {
		await issues.close(t.repo, t.number, CLOSE_DELETED);
		delete tracked[key];
		await issueLedger.save(noteId, tracked);
	}
	await issueLedger.remove(noteId);
	return total;
}

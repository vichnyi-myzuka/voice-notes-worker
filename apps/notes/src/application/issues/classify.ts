import { isJsonObject, parseJsonObject, type Llm } from "@voice-notes/core";
import type { IssueRepo } from "../../domain/issues";
import type { TriageItem } from "../../domain/tracker";

export const CLASSIFY_SYSTEM = `You decide which tasks from the author's voice note are work on one of the author's long-running software projects.
Such tasks are tracked as GitHub issues, in addition to the author's personal to-do list.
For each task in <tasks> return its key and "repo": the full name of the repository from <repos> the task belongs to, or "" if it is not work on one of these projects.
Work on a project means development of the project itself: features, bugs, refactoring, tests, documentation, infrastructure and deployment of that project.
Personal, household and generic tasks, errands, calls, purchases and reminders are NOT project work: return "". When unsure, return "".`;

// Які з нових задач — робота над проєктом (і в який репозиторій). Невдача — null, відповідь іншого репозиторію ігноруємо.
export async function classifyIssues(llm: Llm, items: TriageItem[], repos: IssueRepo[]): Promise<Record<string, string> | null> {
	const names = repos.map((r) => r.repo);
	const schema = {
		type: "object",
		properties: {
			items: {
				type: "array",
				items: {
					type: "object",
					properties: { key: { type: "string" }, repo: { type: "string", enum: [...names, ""] } },
					required: ["key", "repo"],
					additionalProperties: false,
				},
			},
		},
		required: ["items"],
		additionalProperties: false,
	};
	const user = [
		`<repos>\n${repos.map((r) => `${r.repo}: ${r.description}`).join("\n")}\n</repos>`,
		`<tasks>\n${items.map((i) => `${i.key}: ${i.title}${i.details ? ` (${i.details})` : ""}`).join("\n")}\n</tasks>`,
	].join("\n\n");
	return llm.askJson({ name: "issue_repos", system: CLASSIFY_SYSTEM, user, schema, reasoning: "low" }, (text) => {
		const raw = parseJsonObject(text).items;
		if (!Array.isArray(raw)) throw new Error("no items");
		const result: Record<string, string> = {};
		for (const r of raw.filter(isJsonObject)) {
			if (typeof r.key === "string" && typeof r.repo === "string" && names.includes(r.repo)) result[r.key] = r.repo;
		}
		return result;
	});
}

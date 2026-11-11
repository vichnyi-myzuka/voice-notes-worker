import type { Env } from "../env";
import { askJson, parseJsonObject } from "../llm";
import { TASK_FIELDS_HELP, taskFieldsSchema, taskRulesBlock, taskValidator } from "./fields";
import type { TodoistSnapshot, TriageItem } from "./types";
import { promptDate } from "./utils";

export const TRIAGE_SYSTEM = `You triage tasks from a Ukrainian voice note into the author's Todoist.
For each task in <tasks>, return exactly one item, in the same order:
- quote: the exact fragment of the transcript where this specific task is mentioned (one sentence or clause, copied verbatim).
- title: a concise to-do title in Ukrainian that starts with a verb. Keep the given wording unless it can be made clearer.
- duplicate_of: if an existing open task in <existing_tasks> means the same thing, copy its title exactly as written there; otherwise "". Only mark real duplicates, not merely related tasks.
${TASK_FIELDS_HELP}
Resolve relative dates ("в п'ятницю", "через тиждень") from the recording date.
Decide priority, due and deadline ONLY from the words inside that task's quote. If the quote itself has no words about urgency, importance or timing, the task gets p4, no due and no deadline, even if a neighbouring task is urgent. A deadline alone is not a reason for a higher priority.
If the author says they are waiting for someone or something related to a task, that task is waiting (see the rules for the matching label).
Follow the author's rules in <rules>.`;

export async function triage(
	env: Env,
	transcript: string,
	tasks: string[],
	snap: TodoistSnapshot,
	recordedAt: Date,
	timeZone: string,
): Promise<TriageItem[] | null> {
	const itemSchema = {
		type: "object",
		properties: {
			quote: { type: "string" }, // спершу цитата: пріоритет і дати модель виводить лише з неї
			title: { type: "string" },
			duplicate_of: { type: "string" },
			...taskFieldsSchema(snap),
		},
		required: ["quote", "title", "duplicate_of", "project", "labels", "priority", "due", "deadline", "recurrence", "recurrence_label", "reminders", "details"],
		additionalProperties: false,
	};
	const schema = {
		type: "object",
		properties: { items: { type: "array", items: itemSchema } },
		required: ["items"],
		additionalProperties: false,
	};
	const user = [
		`Recording date: ${promptDate(recordedAt, timeZone)}`,
		taskRulesBlock(snap),
		`<existing_tasks>\n${snap.tasks.join("\n")}\n</existing_tasks>`,
		`<tasks>\n${tasks.join("\n")}\n</tasks>`,
		`<transcript>\n${transcript}\n</transcript>`,
	].join("\n\n");
	const validate = taskValidator(snap, recordedAt, timeZone);

	return askJson(env, { name: "todoist_triage", system: TRIAGE_SYSTEM, user, schema, reasoning: "low" }, (text) => {
		const raw = parseJsonObject(text).items;
		if (!Array.isArray(raw)) throw new Error("no items");
		return raw
			.map((r: Record<string, unknown>, i: number) => ({ ...validate(r), key: `t${i + 1}` }))
			.filter((i) => i.title);
	});
}

// Опис полів задач для моделі редагування.
export const EDIT_TASKS_HELP = `If tasks have Todoist fields (project, labels, priority, due, deadline, recurrence, recurrence_label, reminders, details), copy them unchanged unless the instruction changes them. Field meanings:
${TASK_FIELDS_HELP}
Follow the author's <rules>.`;

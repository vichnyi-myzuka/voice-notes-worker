import type { Env } from "../../infrastructure/env";
import type { Llm } from "@voice-notes/core";
import { parseEditedNote, plainTasks, type Meta } from "../../domain/note";
import type { Note } from "../../domain/published";
import { promptDate } from "../../domain/recording";
import type { TaskTracker, TrackerSnapshot, TriageItem } from "../../domain/tracker";
import { SUMMARY_SCHEMA, SYSTEM_PROMPT } from "./summary";

export const editSystem = (tracker: TaskTracker) => `${SYSTEM_PROMPT}

Editing mode: you get an existing note (<note> JSON), its original transcript, earlier edit instructions and a new spoken edit instruction from the author.
Return the full updated note. Apply exactly what the instruction asks (rename, add, remove, reword, change dates, projects, labels or priority of tasks, etc.) and keep everything else unchanged.
Tasks: return every task that should remain, in order. An existing task keeps its "key" even if you change its title or fields; a new task gets key "". A removed task is simply omitted.
Keep the summary and ideas consistent with the edited note: if the instruction changes something they mention (a date, a removed task), update that part, otherwise leave them as is.
Removing a property of a task ("прибери повтор", "зроби разовою", "без дати", "прибери нагадування", "зніми мітку") keeps the task and clears only that field (removing a recurrence keeps due as the next occurrence, so the task stays a one-time task on that date); remove a task only when the instruction asks to remove the task itself.
Change a task's title only when the instruction asks to rename or reword it. Moving a task in time ("перенеси на п'ятницю", "зроби на сьогодні") changes only due/deadline and never turns into a title like "Перенести …".
${tracker.prompts.help}
Commands in the instruction that change the Todoist setup (create, rename or delete a project or a label, change its description) are carried out separately and are already applied: never turn them into tasks; if the instruction has nothing else, return the note unchanged with discard "none". If a task's project or label was renamed, use the new name from <projects> / <labels>.
Relative dates in the instruction ("сьогодні", "завтра", "в п'ятницю") are counted from the edit date; in the original transcript, from the recording date.
In editing mode, discard means: "delete" if the author asks to delete the whole note ("видали нотатку", "видали цей запис повністю", "видали все") — not when they ask to remove one or some tasks, that is a normal edit; "cancelled" if the author cancels this edit itself ("скасуй", "нічого не міняй"); "empty" if the instruction has no meaningful content; otherwise "none".`;

export async function editNote(
	env: Env,
	llm: Llm,
	tracker: TaskTracker,
	note: Note,
	instruction: string,
	snap: TrackerSnapshot | null,
): Promise<{ meta: Meta; triage: TriageItem[] | null } | null> {
	const { title, summary, ideas } = note.meta;
	const oldTasks = note.triage ?? plainTasks(note.meta.tasks);
	const tasks = oldTasks.map(({ key, title, project, labels, priority, due, deadline, recurrence, recurrenceLabel, reminders, details, duplicateOf }) =>
		snap
			? {
					key,
					title,
					project,
					labels,
					priority: `p${priority}`,
					due,
					deadline,
					recurrence: recurrence ?? "",
					recurrence_label: recurrenceLabel ?? "",
					// у форматі для моделі: "before 60" або "2026-11-11 09:00"
					reminders: (reminders ?? []).map((r) => (r.startsWith("before:") ? r.replace(":", " ") : r.replace("T", " "))),
					details: details ?? "",
					...(duplicateOf && { already_exists_as: duplicateOf }),
				}
			: { key, title },
	);
	const taskSchema = {
		type: "object",
		properties: { key: { type: "string" }, title: { type: "string" }, ...(snap ? tracker.prompts.fieldsSchema(snap) : {}) },
		required: snap
			? ["key", "title", "project", "labels", "priority", "due", "deadline", "recurrence", "recurrence_label", "reminders", "details"]
			: ["key", "title"],
		additionalProperties: false,
	};
	const schema = {
		...SUMMARY_SCHEMA,
		properties: {
			...SUMMARY_SCHEMA.properties,
			tasks: { type: "array", items: taskSchema },
			discard: { type: "string", enum: ["none", "empty", "cancelled", "delete"] },
		},
	};
	const now = new Date();
	const user = [
		`Recording date: ${promptDate(new Date(note.recordedTs), env.TIMEZONE)}`,
		`Edit date: ${promptDate(now, env.TIMEZONE)}`,
		snap ? tracker.prompts.rulesBlock(snap) : "",
		`<note>\n${JSON.stringify({ title, summary, ideas, tasks })}\n</note>`,
		`<transcript>\n${note.transcript}\n</transcript>`,
		note.edits.length ? `<earlier_edits>\n${note.edits.join("\n")}\n</earlier_edits>` : "",
		`<instruction>\n${instruction}\n</instruction>`,
	]
		.filter(Boolean)
		.join("\n\n");

	// "today"/"tomorrow" у правці рахуються від дати правки.
	const validate = snap ? tracker.prompts.validator(snap, now) : null;
	return llm.askJson({ name: "voice_note_edit", system: editSystem(tracker), user, schema }, (text) =>
		parseEditedNote(text, oldTasks, validate),
	);
}

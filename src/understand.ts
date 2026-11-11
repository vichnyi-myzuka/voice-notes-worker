import type { Env } from "./env";
import { askJson, parseJsonObject, toBase64 } from "./llm";
import { parseEditedNote, parseMeta, plainTasks, type Meta } from "./note";
import type { Note } from "./published";
import { EDIT_TASKS_HELP, promptDate, taskFieldsSchema, taskRulesBlock, taskValidator, type TodoistSnapshot, type TriageItem } from "./todoist";

// Розуміння запису: голос → текст (Whisper), фото → текст (vision), текст → назва, summary й задачі (LLM), правка нотатки.

// ---------- Workers AI: whisper-large-v3-turbo ----------
export async function transcribe(env: Env, audio: ArrayBuffer, contentType: string): Promise<string> {
	// Аудіо передаємо потоком (без base64): m4a з шорткату або ogg/opus з Telegram.
	// Автор завжди говорить українською, тож задаємо мову явно, щоб модель не сплутала її з російською.
	const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
		audio: { body: new Blob([audio]).stream(), contentType },
		language: "uk",
	});
	return (res.text ?? "").trim();
}

// ---------- Фото: текст на зображенні й опис (vision), далі — як текстова нотатка ----------
const IMAGE_SYSTEM = `The author sent a photo as a note, optionally with a caption. Read the image.
- text: all text visible on the image, verbatim, in its original language, keeping line breaks; "" if there is none.
- description: 1–2 sentences in Ukrainian on what the image shows (e.g. receipt, screenshot of a chat, handwritten list, poster, whiteboard), without repeating the text.`;

export async function readImage(env: Env, image: ArrayBuffer, type: string, caption: string, lastAttempt: boolean): Promise<string> {
	const schema = {
		type: "object",
		properties: { text: { type: "string" }, description: { type: "string" } },
		required: ["text", "description"],
		additionalProperties: false,
	};
	const res = await askJson(
		env,
		{ name: "image_note", system: IMAGE_SYSTEM, user: caption ? `Caption: ${caption}` : "No caption.", schema, image: { base64: toBase64(image), type } },
		(t) => {
			const j = parseJsonObject(t);
			return { text: String(j.text ?? "").trim(), description: String(j.description ?? "").trim() };
		},
	);
	if (!res && !lastAttempt) throw new Error("All image models failed");
	return [
		caption && `Підпис автора: ${caption}`,
		res?.description && `Що на фото: ${res.description}`,
		res?.text && `Текст на фото:\n${res.text}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

// ---------- Title + summary: gpt-6-luna, при збої — Gemma 4 ----------
const SYSTEM_PROMPT = `You write a title, a summary, key ideas and tasks for a voice note transcript.
The author always speaks Ukrainian.
Rules:
- Always write everything in Ukrainian, even if the transcript contains words or phrases in other languages or was transcribed imperfectly.
- Keep names, brands and technical terms as they are commonly written.
- title: at most 6 words, no quotes, no trailing period.
- summary: 2-4 sentences.
- ideas: the main thoughts, decisions or insights voiced in the note, up to 5 items, each under 12 words. Do not repeat the summary word for word.
- tasks: concrete action items, todos, reminders and wishes for later ("колись хочу прочитати…") mentioned in the note, up to 10 items, each under 12 words and starting with a verb; include deadlines or people if mentioned. Keep separate actions as separate items.
- Do not create vague "start" tasks ("почати роботу над…", "зайнятися…", "працювати над проєктом…") when the note also names a concrete action for the same thing. Merge them into one concrete task and keep the timing from the vague one. Example: "19 листопада треба почати новий проєкт, там треба розгорнути інстанс на Cloudflare" → one task: "Розгорнути інстанс на Cloudflare для нового проєкту" (the 19 November timing belongs to it).
- If there are no ideas or no tasks, return an empty array for that field. Do not invent anything that is not in the transcript.
- discard: normally "none". Use "empty" when the transcript has no meaningful content: silence, noise, filler, or typical speech-recognition hallucinations on silence ("Дякую за перегляд", "Субтитри зроблені…", "Продовження наступне", a single repeated word). Use "cancelled" when the author explicitly asks to cancel, discard or not save this whole recording ("скасуй", "відміна, не зберігай", "видали цей запис", "забудь, не надсилай"), usually at the end. A cancel phrase that is about a real-world thing ("скасувати зустріч", "відмінити підписку") is a task, not "cancelled". When discard is not "none", the other fields may be empty.
- Commands that change the Todoist setup (create, rename or delete a project or a label, change its description: "створи проєкт Спорт", "видали мітку Office") are carried out automatically: never list them as tasks, mention them briefly in the summary, and never discard such a note as "empty".`;

// Structured output: модель повертає JSON саме такої форми.
const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		summary: { type: "string" },
		ideas: { type: "array", items: { type: "string" } },
		tasks: { type: "array", items: { type: "string" } },
		discard: { type: "string", enum: ["none", "empty", "cancelled"] },
	},
	required: ["title", "summary", "ideas", "tasks", "discard"],
	additionalProperties: false,
};

export async function summarize(env: Env, transcript: string, recordedAt: string, lastAttempt: boolean): Promise<Meta> {
	if (!transcript) return { title: "", summary: "", ideas: [], tasks: [], discard: "empty" };

	const meta = await askJson(
		env,
		{ name: "voice_note", system: SYSTEM_PROMPT, user: `<transcript>\n${transcript}\n</transcript>`, schema: SUMMARY_SCHEMA },
		parseMeta,
	);
	if (meta) return meta;

	// Обидві моделі не впорались: ретраїмо, а на останній спробі — fallback замість DLQ.
	if (!lastAttempt) throw new Error("All summary models failed");
	return {
		title: recordedAt,
		summary: transcript.length > 300 ? `${transcript.slice(0, 300)}…` : transcript,
		ideas: [],
		tasks: [],
	};
}

const EDIT_SYSTEM = `${SYSTEM_PROMPT}

Editing mode: you get an existing note (<note> JSON), its original transcript, earlier edit instructions and a new spoken edit instruction from the author.
Return the full updated note. Apply exactly what the instruction asks (rename, add, remove, reword, change dates, projects, labels or priority of tasks, etc.) and keep everything else unchanged.
Tasks: return every task that should remain, in order. An existing task keeps its "key" even if you change its title or fields; a new task gets key "". A removed task is simply omitted.
Keep the summary and ideas consistent with the edited note: if the instruction changes something they mention (a date, a removed task), update that part, otherwise leave them as is.
Removing a property of a task ("прибери повтор", "зроби разовою", "без дати", "прибери нагадування", "зніми мітку") keeps the task and clears only that field (removing a recurrence keeps due as the next occurrence, so the task stays a one-time task on that date); remove a task only when the instruction asks to remove the task itself.
Change a task's title only when the instruction asks to rename or reword it. Moving a task in time ("перенеси на п'ятницю", "зроби на сьогодні") changes only due/deadline and never turns into a title like "Перенести …".
${EDIT_TASKS_HELP}
Commands in the instruction that change the Todoist setup (create, rename or delete a project or a label, change its description) are carried out separately and are already applied: never turn them into tasks; if the instruction has nothing else, return the note unchanged with discard "none". If a task's project or label was renamed, use the new name from <projects> / <labels>.
Relative dates in the instruction ("сьогодні", "завтра", "в п'ятницю") are counted from the edit date; in the original transcript, from the recording date.
In editing mode, discard means: "delete" if the author asks to delete the whole note ("видали нотатку", "видали цей запис повністю", "видали все") — not when they ask to remove one or some tasks, that is a normal edit; "cancelled" if the author cancels this edit itself ("скасуй", "нічого не міняй"); "empty" if the instruction has no meaningful content; otherwise "none".`;

export async function editNote(
	env: Env,
	note: Note,
	instruction: string,
	snap: TodoistSnapshot | null,
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
		properties: { key: { type: "string" }, title: { type: "string" }, ...(snap ? taskFieldsSchema(snap) : {}) },
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
		snap ? taskRulesBlock(snap) : "",
		`<note>\n${JSON.stringify({ title, summary, ideas, tasks })}\n</note>`,
		`<transcript>\n${note.transcript}\n</transcript>`,
		note.edits.length ? `<earlier_edits>\n${note.edits.join("\n")}\n</earlier_edits>` : "",
		`<instruction>\n${instruction}\n</instruction>`,
	]
		.filter(Boolean)
		.join("\n\n");

	// "today"/"tomorrow" у правці рахуються від дати правки.
	const validate = snap ? taskValidator(snap, now, env.TIMEZONE) : null;
	return askJson(env, { name: "voice_note_edit", system: EDIT_SYSTEM, user, schema }, (text) =>
		parseEditedNote(text, oldTasks, validate),
	);
}

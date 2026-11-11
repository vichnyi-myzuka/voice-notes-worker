import { withAppliedRecurrence } from "../tasks";
import { buildCaption, taskLinks, type Meta } from "../../domain/note";
import type { Note } from "../../domain/published";
import type { Env } from "../../infrastructure/env";
import type { Ports } from "./types";
import type { TriageItem } from "../../domain/tracker";

export const TODOIST_FAILED = "⚠️ Не вдалося оновити Todoist";

// Блок під нотаткою: зміни налаштувань Todoist і збій задач.
export const captionNotice = (setup: string[] | undefined, failed: boolean) =>
	[setup?.length ? `⚙️ Todoist:\n${setup.join("\n")}` : "", failed ? TODOIST_FAILED : ""].filter(Boolean).join("\n\n");

// Оновлює повідомлення нотатки: назви задач, що вже в Todoist, — посилання на них, 🔁 лише в задач, де Todoist прийняв повтор.
// Текстова нотатка — це текст повідомлення з цитатою оригіналу.
export async function showNote(
	env: Env,
	{ channel, tracker, ledger }: Ports,
	noteId: string,
	note: Note,
	{ meta, triage, notice }: { meta: Meta; triage: TriageItem[] | null; notice: string },
): Promise<void> {
	const inTodoist = await ledger.get(noteId);
	const shown = withAppliedRecurrence(triage, inTodoist);
	const caption = buildCaption(meta, shown, note.recordedTs, env.TIMEZONE, notice, note.text ? channel.limits.textNote : channel.limits.caption);
	const ids = Object.fromEntries(Object.entries(inTodoist).map(([key, v]) => [key, v.id]));
	await channel.update(note.messageId, caption, taskLinks(caption, shown, ids, tracker.taskUrl), note.text ? note.transcript : undefined);
}

// Перемальовує збережену нотатку (після виконання задач у Todoist).
export async function refreshNote(env: Env, ports: Ports, noteId: string, failed: boolean): Promise<void> {
	const note = await ports.notes.load(noteId);
	if (!note) return;
	await showNote(env, ports, noteId, note, { meta: note.meta, triage: note.triage, notice: captionNotice(note.setup, failed) });
}

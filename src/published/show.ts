import type { Env } from "../env";
import { CAPTION_MAX, TEXT_CAPTION_MAX, buildCaption, taskLinks, textNote, type Meta } from "../note";
import { getInTodoist, withAppliedRecurrence } from "../tasks";
import { NO_PREVIEW, tg } from "../telegram";
import type { TriageItem } from "../todoist";
import { loadNote } from "./store";
import type { Note } from "./types";

export const TODOIST_FAILED = "⚠️ Не вдалося оновити Todoist";

// Блок під нотаткою: зміни налаштувань Todoist і збій задач.
export const captionNotice = (setup: string[] | undefined, failed: boolean) =>
	[setup?.length ? `⚙️ Todoist:\n${setup.join("\n")}` : "", failed ? TODOIST_FAILED : ""].filter(Boolean).join("\n\n");

// Оновлює повідомлення нотатки: назви задач, що вже в Todoist, — посилання на них, 🔁 лише в задач, де Todoist прийняв повтор.
// Текстова нотатка — це текст повідомлення з цитатою оригіналу.
export async function showNote(
	env: Env,
	noteId: string,
	note: Note,
	{ meta, triage, notice }: { meta: Meta; triage: TriageItem[] | null; notice: string },
): Promise<void> {
	const inTodoist = await getInTodoist(env, noteId);
	const shown = withAppliedRecurrence(triage, inTodoist);
	const caption = buildCaption(meta, shown, note.recordedTs, env.TIMEZONE, notice, note.text ? TEXT_CAPTION_MAX : CAPTION_MAX);
	const ids = Object.fromEntries(Object.entries(inTodoist).map(([key, v]) => [key, v.id]));
	const entities = taskLinks(caption, shown, ids);
	const common = { chat_id: env.CHAT_ID, message_id: note.messageId };
	await (
		note.text
			? tg(env, "editMessageText", { ...common, ...textNote(caption, note.transcript, entities), link_preview_options: NO_PREVIEW })
			: tg(env, "editMessageCaption", { ...common, caption, caption_entities: entities })
	).catch((err) => {
		if (!String(err).includes("message is not modified")) throw err;
	});
}

// Перемальовує збережену нотатку (після виконання задач у Todoist).
export async function refreshNote(env: Env, noteId: string, failed: boolean): Promise<void> {
	const note = await loadNote(env, noteId);
	if (!note) return;
	await showNote(env, noteId, note, { meta: note.meta, triage: note.triage, notice: captionNotice(note.setup, failed) });
}

import type { Env } from "./index";
import { buildCaption, CAPTION_MAX, taskLinks, textNote, TEXT_CAPTION_MAX, type Meta } from "./note";
import { NO_PREVIEW, tg } from "./telegram";
import { getInTodoist, withAppliedRecurrence } from "./tasks";
import type { TriageItem } from "./todoist";

// Опублікована нотатка: запис у R2 для редагування (`notes/<id>.json`, 7 днів за lifecycle бакета)
// і її повідомлення в каналі. Тут живуть ключі R2 і оновлення повідомлення; решта коду їх не знає.
// `notes/msg-<message_id>` вказує на id нотатки: так відповідь у каналі знаходить, що редагувати.
export type Note = {
	transcript: string;
	edits: string[]; // інструкції попередніх редагувань
	meta: Meta;
	triage: TriageItem[] | null;
	messageId: number;
	recordedTs: number;
	text?: boolean; // текстова нотатка: повідомлення без аудіо, оригінал — у цитаті під підписом
	setup?: string[]; // зміни налаштувань Todoist, зроблені цією нотаткою та її правками (для підпису)
};

const noteKey = (id: string) => `notes/${id}.json`;
const byMessageKey = (messageId: number | string) => `notes/msg-${messageId}`;

// Повторний запис при ретраї нічого не ламає.
export async function saveNote(env: Env, noteId: string, note: Note): Promise<void> {
	await env.BUCKET.put(noteKey(noteId), JSON.stringify(note));
	await env.BUCKET.put(byMessageKey(note.messageId), noteId);
}

export async function loadNote(env: Env, noteId: string): Promise<Note | null> {
	return (await (await env.BUCKET.get(noteKey(noteId)))?.json<Note>()) ?? null;
}

// id нотатки за повідомленням у каналі (відповідь на нотатку = редагування); null, якщо це не наша нотатка.
export async function noteIdByMessage(env: Env, messageId: number | string): Promise<string | null> {
	return (await (await env.BUCKET.get(byMessageKey(messageId)))?.text()) || null;
}

// Прибирає запис нотатки в R2 разом зі станом її задач у Todoist (повідомлення в каналі видаляє викликач).
export async function removeNote(env: Env, noteId: string, note: Note): Promise<void> {
	await env.BUCKET.delete([noteKey(noteId), byMessageKey(note.messageId), `notes/${noteId}.todoist.json`]);
}

const TODOIST_FAILED = "⚠️ Не вдалося оновити Todoist";

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

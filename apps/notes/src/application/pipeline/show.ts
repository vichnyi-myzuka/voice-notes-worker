import { withAppliedRecurrence } from "../tasks";
import { buildCaption, taskLinks, type Meta } from "../../domain/note";
import type { Note } from "../../domain/published";
import type { Env } from "../../infrastructure/env";
import type { Ports } from "./types";
import type { TriageItem } from "../../domain/tracker";

export const TODOIST_FAILED = "⚠️ Не вдалося оновити Todoist";
export const GITHUB_FAILED = "⚠️ Не вдалося оновити GitHub issues";

// Блок під нотаткою: зміни налаштувань Todoist і збій задач та issues.
export const captionNotice = (setup: string[] | undefined, failed: boolean, issuesFailed = false) =>
	[setup?.length ? `⚙️ Todoist:\n${setup.join("\n")}` : "", failed ? TODOIST_FAILED : "", issuesFailed ? GITHUB_FAILED : ""].filter(Boolean).join("\n\n");

// Оновлює повідомлення нотатки: назви задач, що вже в Todoist, — посилання на них, 🔁 лише в задач, де Todoist прийняв повтор.
// Текстова нотатка — це текст повідомлення з цитатою оригіналу.
export async function showNote(
	env: Env,
	{ channel, tracker, ledger, issueLedger }: Ports,
	noteId: string,
	note: Note,
	{ meta, triage, notice }: { meta: Meta; triage: TriageItem[] | null; notice: string },
): Promise<void> {
	const inTodoist = await ledger.get(noteId);
	const shown = withAppliedRecurrence(triage, inTodoist);
	// Створені issues: посилання окремим рядком у блоці під нотаткою (Telegram робить їх клікабельними сам).
	const links = Object.values(await issueLedger.get(noteId)).map((i) => `• ${i.url}`);
	const withIssues = [notice, links.length ? `🐙 GitHub issues:\n${links.join("\n")}` : ""].filter(Boolean).join("\n\n");
	const caption = buildCaption(meta, shown, note.recordedTs, env.TIMEZONE, withIssues, note.text ? channel.limits.textNote : channel.limits.caption);
	const ids = Object.fromEntries(Object.entries(inTodoist).map(([key, v]) => [key, v.id]));
	await channel.update(note.messageId, caption, taskLinks(caption, shown, ids, tracker.taskUrl), note.text ? note.transcript : undefined);
}

// Перемальовує збережену нотатку (після виконання задач у Todoist).
export async function refreshNote(env: Env, ports: Ports, noteId: string, failed: boolean, issuesFailed = false): Promise<void> {
	const note = await ports.notes.load(noteId);
	if (!note) return;
	await showNote(env, ports, noteId, note, { meta: note.meta, triage: note.triage, notice: captionNotice(note.setup, failed, issuesFailed) });
}

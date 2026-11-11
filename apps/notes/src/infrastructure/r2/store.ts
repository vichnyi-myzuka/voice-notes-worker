import type { Note, NoteRepository } from "../../domain/published";
import type { IssueLedger, TrackedIssues } from "../../domain/issues";
import type { TaskLedger, TrackedTasks } from "../../domain/tracker";
import type { Env } from "../env";

const noteKey = (id: string) => `notes/${id}.json`;
const byMessageKey = (messageId: number | string) => `notes/msg-${messageId}`;
const issuesKey = (noteId: string) => `notes/${noteId}.issues.json`;
const ledgerKey = (noteId: string) => `notes/${noteId}.tasks.json`;
// До перейменування ключ мав назву трекера: нотатки, створені раніше (живуть 7 днів), читаємо й чистимо за старим.
// TODO: прибрати fallback, коли всі такі нотатки застаріють.
const legacyLedgerKey = (noteId: string) => `notes/${noteId}.todoist.json`;

// Адаптер NoteRepository: нотатки в R2. Повторний запис при ретраї нічого не ламає.
export function r2Notes(env: Env): NoteRepository {
	return {
		async save(noteId, note) {
			await env.BUCKET.put(noteKey(noteId), JSON.stringify(note));
			await env.BUCKET.put(byMessageKey(note.messageId), noteId);
		},
		async load(noteId) {
			return (await (await env.BUCKET.get(noteKey(noteId)))?.json<Note>()) ?? null;
		},
		async idByMessage(messageId) {
			return (await (await env.BUCKET.get(byMessageKey(messageId)))?.text()) || null;
		},
		async remove(noteId, note) {
			await env.BUCKET.delete([noteKey(noteId), byMessageKey(note.messageId)]);
		},
	};
}

// Адаптер TaskLedger: задачі нотатки в R2.
export function r2Ledger(env: Env): TaskLedger {
	return {
		async get(noteId) {
			const stored = (await env.BUCKET.get(ledgerKey(noteId))) ?? (await env.BUCKET.get(legacyLedgerKey(noteId)));
			return (await stored?.json<TrackedTasks>()) ?? {};
		},
		async save(noteId, tracked) {
			await env.BUCKET.put(ledgerKey(noteId), JSON.stringify(tracked));
		},
		async remove(noteId) {
			await env.BUCKET.delete([ledgerKey(noteId), legacyLedgerKey(noteId)]);
		},
	};
}

// Адаптер IssueLedger: GitHub issues нотатки в R2.
export function r2IssueLedger(env: Env): IssueLedger {
	return {
		async get(noteId) {
			return (await (await env.BUCKET.get(issuesKey(noteId)))?.json<TrackedIssues>()) ?? {};
		},
		async save(noteId, tracked) {
			await env.BUCKET.put(issuesKey(noteId), JSON.stringify(tracked));
		},
		async remove(noteId) {
			await env.BUCKET.delete(issuesKey(noteId));
		},
	};
}

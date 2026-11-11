import type { Env } from "../../infrastructure/env";
import type { Note } from "./types";

export const noteKey = (id: string) => `notes/${id}.json`;

export const byMessageKey = (messageId: number | string) => `notes/msg-${messageId}`;

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

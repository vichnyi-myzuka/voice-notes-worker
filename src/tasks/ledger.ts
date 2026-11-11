import type { Env } from "../env";
import type { InTodoist } from "./types";

export const inTodoistKey = (noteId: string) => `notes/${noteId}.todoist.json`;

export async function getInTodoist(env: Env, noteId: string): Promise<InTodoist> {
	return (await (await env.BUCKET.get(inTodoistKey(noteId)))?.json<InTodoist>()) ?? {};
}

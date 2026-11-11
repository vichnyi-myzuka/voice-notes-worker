import type { Env } from "../env";

// Кладе аудіо в R2 і ставить у чергу.
export async function enqueueNote(
	env: Env,
	key: string,
	body: ArrayBuffer,
	contentType: string,
	customMetadata?: Record<string, string | undefined>,
	edit?: string,
): Promise<void> {
	const meta = Object.fromEntries(Object.entries(customMetadata ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
	await env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: meta });
	await env.QUEUE.send(edit ? { key, edit } : { key });
}

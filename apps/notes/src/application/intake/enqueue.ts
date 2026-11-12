import type { RecordingStore } from "../../domain/recording";
import type { Env } from "../../infrastructure/env";

type Metadata = Record<string, string | undefined>;

// Кладе запис у сховище і ставить у чергу; edit — id нотатки, яку редагує запис.
export async function enqueueNote(
	env: Env,
	recordings: RecordingStore,
	{ key, body, contentType, metadata = {}, edit }: { key: string; body: ArrayBuffer; contentType: string; metadata?: Metadata; edit?: string },
): Promise<void> {
	const customMetadata: Record<string, string> = {};
	for (const [name, value] of Object.entries(metadata)) if (value !== undefined) customMetadata[name] = value;
	await recordings.put(key, body, { contentType, metadata: customMetadata });
	await env.QUEUE.send(edit ? { key, edit } : { key });
}

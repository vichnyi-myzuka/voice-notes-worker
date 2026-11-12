import { captionKey, stateKey, type RecordingStore } from "../../domain/recording";
import type { Env } from "../env";

// Адаптер RecordingStore: записи, підписи до фото й стан обробки в R2 (записи живуть 7 днів за lifecycle бакета).
export function r2Recordings(env: Env): RecordingStore {
	return {
		async put(key, body, { contentType, metadata }) {
			await env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: metadata });
		},
		async get(key) {
			const obj = await env.BUCKET.get(key);
			if (!obj) return null;
			// Тіло об'єкта R2 читається лише раз, тож кешуємо.
			let data: ArrayBuffer | undefined;
			return {
				size: obj.size,
				contentType: obj.httpMetadata?.contentType ?? "audio/mp4",
				metadata: obj.customMetadata,
				text: () => obj.text(),
				bytes: async () => (data ??= await obj.arrayBuffer()),
			};
		},
		async putCaption(key, caption) {
			await env.BUCKET.put(captionKey(key), caption);
		},
		async caption(key) {
			return (await (await env.BUCKET.get(captionKey(key)))?.text()) ?? "";
		},
		async remove(key) {
			await env.BUCKET.delete([key, stateKey(key), captionKey(key)]);
		},
	};
}

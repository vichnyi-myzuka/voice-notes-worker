import type { Env } from "../src/infrastructure/env";

// Мінімальний R2 у пам'яті: лише те, що використовує воркер (get/put/head/delete).
export function fakeEnv(vars: Partial<Env> = {}): Env & { store: Map<string, string> } {
	const store = new Map<string, string>();
	const options = new Map<string, { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();
	const object = (k: string) => {
		const v = store.get(k)!;
		return {
			json: async () => JSON.parse(v),
			text: async () => v,
			arrayBuffer: async () => new TextEncoder().encode(v).buffer,
			size: v.length,
			...options.get(k),
		};
	};
	const BUCKET = {
		get: async (k: string) => (store.has(k) ? object(k) : null),
		head: async (k: string) => (store.has(k) ? {} : null),
		put: async (k: string, v: string | ArrayBuffer, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => {
			store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v)); // тіло запису з вебхука — ArrayBuffer
			if (opts) options.set(k, opts);
		},
		delete: async (k: string | string[]) => [k].flat().forEach((x) => (store.delete(x), options.delete(x))),
	};
	return {
		BUCKET,
		store,
		TIMEZONE: "Europe/Kyiv",
		CHAT_ID: "-1004390223227",
		...vars,
	} as unknown as Env & { store: Map<string, string> };
}

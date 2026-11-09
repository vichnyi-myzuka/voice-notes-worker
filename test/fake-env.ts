import type { Env } from "../src/index";

// Мінімальний R2 у пам'яті: лише те, що використовує воркер (get/put/head/delete).
export function fakeEnv(vars: Partial<Env> = {}): Env & { store: Map<string, string> } {
	const store = new Map<string, string>();
	const object = (v: string) => ({ json: async () => JSON.parse(v), text: async () => v });
	const BUCKET = {
		get: async (k: string) => (store.has(k) ? object(store.get(k)!) : null),
		head: async (k: string) => (store.has(k) ? {} : null),
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string | string[]) => [k].flat().forEach((x) => store.delete(x)),
	};
	return {
		BUCKET,
		store,
		TIMEZONE: "Europe/Kyiv",
		CHAT_ID: "-1004390223227",
		...vars,
	} as unknown as Env & { store: Map<string, string> };
}

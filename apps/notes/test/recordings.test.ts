import { describe, expect, it } from "vitest";
import { r2Recordings } from "../src/infrastructure/r2";
import { fakeEnv } from "./fake-env";

const KEY = "1762700000000-abcd1234.m4a";
const body = () => new TextEncoder().encode("audio").buffer as ArrayBuffer;

describe("r2Recordings", () => {
	it("зберігає запис і віддає тип, метадані та тіло", async () => {
		const env = fakeEnv();
		const store = r2Recordings(env);
		await store.put(KEY, body(), { contentType: "audio/ogg", metadata: { fileId: "f1" } });

		const rec = (await store.get(KEY))!;
		expect(rec.contentType).toBe("audio/ogg");
		expect(rec.metadata).toEqual({ fileId: "f1" });
		expect(new TextDecoder().decode(await rec.bytes())).toBe("audio");
	});

	it("без типу вважає запис аудіо, а відсутній запис — null", async () => {
		const env = fakeEnv();
		await env.BUCKET.put(KEY, "x");
		expect((await r2Recordings(env).get(KEY))!.contentType).toBe("audio/mp4");
		expect(await r2Recordings(env).get("nope")).toBeNull();
	});

	it("підпис: порожній, якщо немає", async () => {
		const store = r2Recordings(fakeEnv());
		expect(await store.caption(KEY)).toBe("");
		await store.putCaption(KEY, "підпис");
		expect(await store.caption(KEY)).toBe("підпис");
	});

	it("remove прибирає запис, підпис і стан обробки", async () => {
		const env = fakeEnv();
		const store = r2Recordings(env);
		await store.put(KEY, body(), { contentType: "audio/mp4", metadata: {} });
		await store.putCaption(KEY, "c");
		await env.BUCKET.put(`${KEY}.state.json`, "{}");
		await env.BUCKET.put("notes/n1.json", "{}");

		await store.remove(KEY);

		expect([...env.store.keys()]).toEqual(["notes/n1.json"]);
	});
});

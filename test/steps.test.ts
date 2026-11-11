import { describe, expect, it, vi } from "vitest";
import { openSteps } from "../src/infrastructure/steps";
import { fakeEnv } from "./fake-env";

type S = { a?: string; ok?: boolean; n?: number | null };
const KEY = "k.state.json";

describe("openSteps", () => {
	it("виконує крок і зберігає результат у R2", async () => {
		const env = fakeEnv();
		const { step, state } = await openSteps<S>(env, KEY, false);
		expect(await step("a", async () => "x")).toBe("x");
		expect(state.a).toBe("x");
		expect(JSON.parse(env.store.get(KEY)!)).toEqual({ a: "x" });
	});

	it("пропускає виконаний крок при повторній спробі", async () => {
		const env = fakeEnv();
		const fn = vi.fn(async () => "x");
		await (await openSteps<S>(env, KEY, false)).step("a", fn);
		const again = await openSteps<S>(env, KEY, false);
		expect(await again.step("a", fn)).toBe("x");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("null — теж виконаний результат", async () => {
		const env = fakeEnv();
		const fn = vi.fn(async () => null);
		const run = await openSteps<S>(env, KEY, false);
		await run.step("n", fn);
		await (await openSteps<S>(env, KEY, false)).step("n", fn);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("читає старий стан: готові кроки не повторюються", async () => {
		const env = fakeEnv();
		env.store.set(KEY, JSON.stringify({ a: "old", ok: true }));
		const fn = vi.fn(async () => "new");
		const run = await openSteps<S>(env, KEY, false);
		expect(await run.step("a", fn)).toBe("old");
		expect(fn).not.toHaveBeenCalled();
	});

	it("збій не зберігається й кидається до останньої спроби", async () => {
		const env = fakeEnv();
		const run = await openSteps<S>(env, KEY, false);
		await expect(run.step("ok", async () => Promise.reject(new Error("boom")), { onFinalFailure: () => false })).rejects.toThrow("boom");
		expect(env.store.has(KEY)).toBe(false);
	});

	it("на останній спробі деградує до запасного значення й зберігає його", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const env = fakeEnv();
		const run = await openSteps<S>(env, KEY, true);
		expect(await run.step("ok", async () => Promise.reject(new Error("boom")), { onFinalFailure: () => false })).toBe(false);
		expect(JSON.parse(env.store.get(KEY)!)).toEqual({ ok: false });
	});

	it("на останній спробі без onFinalFailure кидає помилку", async () => {
		const env = fakeEnv();
		const run = await openSteps<S>(env, KEY, true);
		await expect(run.step("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	});
});

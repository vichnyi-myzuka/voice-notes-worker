import { describe, expect, it, vi } from "vitest";
import { JOB_ATTEMPTS, Jobs, LIMIT_POLL_MS, Limits } from "../src/application/jobs";
import { fakeNotices, fakeProbe, fakeScheduler, fakeStore } from "./fake-ports";

const target = { chatId: 1, url: "https://x/s" };
const input = { prompt: "зроби" };

function setup(runner: Partial<ConstructorParameters<typeof Jobs>[3]> = {}) {
	const store = fakeStore();
	const sched = fakeScheduler();
	const n = fakeNotices();
	const start = vi.fn(async () => {});
	const followUp = vi.fn(async () => {});
	const jobs = new Jobs(sched.scheduler, store, n.notices, { running: () => true, start, followUp, watch: async () => {}, ...runner });
	return { store, sched, n, jobs, start, followUp };
}

describe("Jobs", () => {
	it("begin ідемпотентний за id й будить alarm", async () => {
		const { jobs, store, sched } = setup();
		await jobs.begin("a", input, target);
		await jobs.begin("a", { prompt: "інше" }, target);
		expect((await store.jobs()).length).toBe(1);
		expect(sched.calls.now).toBe(1);
	});

	it("уточнення дописується до ще не запущеного старту", async () => {
		const { jobs, store } = setup();
		await jobs.begin("a", input, target);
		await jobs.resume("a", "ще це");
		expect(await store.job("a")).toMatchObject({ input: { prompt: "зроби\n\nще це" } });
	});

	it("run запускає завдання і прибирає його після успіху", async () => {
		const { jobs, store, sched, start } = setup();
		await jobs.begin("a", input);
		expect(await jobs.run()).toBe(true);
		await sched.settle();
		expect(start).toHaveBeenCalledWith("a", input);
		expect(await store.jobs()).toEqual([]);
	});

	it("збій повторюється, після JOB_ATTEMPTS власник отримує звіт", async () => {
		const { jobs, store, sched, n } = setup({ start: async () => { throw new Error("boom"); } });
		vi.spyOn(console, "error").mockImplementation(() => {});
		await jobs.begin("a", input, target);
		for (let i = 0; i < JOB_ATTEMPTS; i++) {
			await jobs.run();
			await sched.settle();
		}
		expect(await store.job("a")).toBeUndefined();
		expect(n.sent).toEqual([{ id: "a", text: expect.stringContaining("Не вдалося запустити"), kind: "done" }]);
	});
});

describe("Limits", () => {
	it("без токена підписки нічого не чекає", async () => {
		const store = fakeStore();
		const s = fakeScheduler();
		const limits = new Limits(fakeProbe(false, undefined), store, fakeNotices().notices, s.scheduler);
		await limits.wait("a", target);
		expect(await store.limits()).toEqual([]);
	});

	it("чекає, поки ліміти вичерпано, і пише в тему, коли скинулись", async () => {
		const store = fakeStore();
		const s = fakeScheduler();
		const n = fakeNotices();
		let state: { blocked: boolean; resetAt?: number } = { blocked: true };
		const limits = new Limits({ configured: true, read: async () => state }, store, n.notices, s.scheduler);
		await limits.wait("a", target);
		expect(s.calls.noLater).toHaveLength(1);
		expect(await limits.check()).toBeGreaterThanOrEqual(Date.now() + LIMIT_POLL_MS - 1000);
		expect(n.sent).toEqual([]);
		state = { blocked: false };
		expect(await limits.check()).toBeUndefined();
		expect(n.sent).toEqual([{ id: "a", text: expect.stringContaining("Ліміти Claude скинулись"), kind: "retry" }]);
		expect(await store.limits()).toEqual([]);
	});
});

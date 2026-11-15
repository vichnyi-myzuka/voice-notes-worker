import { afterEach, describe, expect, it, vi } from "vitest";
import { Limits } from "../src/application/jobs";
import { Mcp } from "../src/application/mcp";
import { Forms, Progress } from "../src/application/progress";
import { Watcher } from "../src/application/watch";
import type { OpencodeEvent, SessionInfo, Tracked } from "../src/domain/agent";
import { fakeContainer, fakeHandoffs, fakeMcpAccess, fakeNotices, fakeOpencode, fakePostStore, fakePosts, fakeProbe, fakeScheduler, fakeStore } from "./fake-ports";

const config = { intervalMs: 15_000, maxMs: 2 * 3600_000, summaryMax: 3000, maxCostUsd: 10, maxTokens: 1000 };
const session: Tracked = { ocId: "oc1", repo: "acme/app", post: { postId: 5, header: "Завдання", chatId: 1, url: "https://x/s/s1", threadId: 9 } };
const target = { chatId: 1, url: "https://x/s/s1", postId: 5, header: "Завдання", threadId: 9 };

afterEach(() => vi.restoreAllMocks());

async function setup(opts: { running?: boolean; active?: string[]; info?: SessionInfo; assistant?: { text: string; error?: string }; events?: (OpencodeEvent | undefined)[]; pr?: number | "error" | "none"; token?: boolean; tracked?: Tracked } = {}) {
	const store = fakeStore();
	const records = fakePostStore();
	const post = fakePosts();
	const oc = fakeOpencode({ active: opts.active, info: { oc1: opts.info ?? { outcome: "succeeded" } }, assistant: { oc1: opts.assistant ?? { text: "Зроблено" } }, events: opts.events });
	const n = fakeNotices();
	const sch = fakeScheduler();
	const handoffs = fakeHandoffs();
	const access = fakeMcpAccess();
	const forms = new Forms(store, post.posts, oc.client);
	const progress = new Progress({ enabled: true, llm: { askJson: async () => null, transcribe: async () => "" }, progressMs: 0 }, store, post.posts, forms);
	const limits = new Limits(fakeProbe(false, undefined), store, n.notices, sch.scheduler);
	const mcp = new Mcp(store, access.access, n.notices, async () => {});
	const pulls = { configured: opts.token ?? true, openNumber: async () => { if (opts.pr === "error") throw new Error("boom"); return opts.pr === "none" ? undefined : ((opts.pr as number | undefined) ?? 7); } };
	await store.saveSession("s1", opts.tracked ?? session);
	const watcher = new Watcher({ config, store, records, opencode: oc.client, container: fakeContainer(opts.running ?? true), scheduler: sch.scheduler, notices: n.notices, posts: post.posts, pulls, handoffs: handoffs.spawner, forms, limits, progress, mcp });
	return { store, records, post, oc, n, sch, handoffs, access, watcher };
}

describe("Watcher.watch", () => {
	it("запам'ятовує пост і спостереження, ставить реакцію й іконку, планує опитування", async () => {
		const t = await setup();
		await t.watcher.watch("s1", target);
		expect(await t.store.watch("s1")).toMatchObject({ ocId: "oc1", postId: 5, seenBusy: false });
		expect(t.post.marks).toEqual([true]);
		expect(t.post.icons).toEqual(["working"]);
		expect(t.sch.calls.noLater).toHaveLength(1);
	});

	it("невідома сесія — помилка", async () => {
		const t = await setup();
		await expect(t.watcher.watch("nope", target)).rejects.toThrow("unknown session");
	});
});

describe("Watcher.tick", () => {
	it("контейнер зупинився: каже про це в пості й знімає стеження", async () => {
		const t = await setup({ running: false });
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		expect(await t.watcher.tick()).toBe(false);
		expect(t.post.shown.at(-1)?.status).toContain("Контейнер зупинився");
		expect(await t.store.watch("s1")).toBeUndefined();
	});

	it("вільна сесія після роботи: підсумок ✅ з «Змерджити», коли є відкритий PR", async () => {
		const t = await setup();
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		expect(await t.watcher.tick()).toBe(false);
		expect(t.post.shown.at(-1)).toMatchObject({ final: true });
		expect(t.post.shown.at(-1)?.status).toBe("✅ Готово\n\nЗроблено");
		expect(t.post.marks).toEqual([false]);
		expect(t.post.icons).toContain("done");
		expect(await t.store.watch("s1")).toBeUndefined();
	});

	it("пояснює, чому немає кнопки «Змерджити»", async () => {
		const none = await setup({ pr: "none" });
		await none.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await none.watcher.tick();
		expect(none.post.shown.at(-1)?.status).toContain("немає відкритого PR з гілки agent/s1");
		const noToken = await setup({ token: false });
		await noToken.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await noToken.watcher.tick();
		expect(noToken.post.shown.at(-1)?.status).toContain("немає GITHUB_TOKEN");
	});

	it("зупинка, збій і ліміти Claude", async () => {
		const stopped = await setup({ info: { outcome: "interrupted" } });
		await stopped.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await stopped.watcher.tick();
		expect(stopped.post.shown.at(-1)?.status).toContain("⏹ Зупинено");

		const failed = await setup({ info: { outcome: "failed" }, assistant: { text: "", error: "щось зламалось" } });
		await failed.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await failed.watcher.tick();
		expect(failed.post.shown.at(-1)?.status).toBe("❌ Помилка: щось зламалось");
		expect(failed.post.icons).toContain("failed");

		const limited = await setup({ info: { outcome: "failed" }, assistant: { text: "", error: "You've hit your weekly limit" } });
		await limited.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await limited.watcher.tick();
		expect(limited.post.shown.at(-1)?.status).toContain("Ліміти Claude вичерпано");
	});

	it("перевищення ліміту токенів зупиняє сесію й пише причину", async () => {
		const t = await setup({ active: ["oc1"], info: { tokens: { input: 900, output: 200 } } });
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: Date.now(), seenBusy: true });
		expect(await t.watcher.tick()).toBe(true);
		expect(t.oc.calls.interrupts).toEqual(["oc1"]);
		expect(t.post.shown.at(-1)?.status).toContain("1100 токенів (ліміт 1000)");
	});

	it("працююча сесія лишає стеження й відмічає, що її бачили зайнятою", async () => {
		const t = await setup({ active: ["oc1"], info: {} });
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: Date.now(), seenBusy: false });
		expect(await t.watcher.tick()).toBe(true);
		expect((await t.store.watch("s1"))?.seenBusy).toBe(true);
	});

	it("зображення з підсумку йдуть у чат окремо", async () => {
		const t = await setup({ assistant: { text: "Ось\n\n![графік](/tmp/a.png)" } });
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await t.watcher.tick();
		expect(t.post.shown.at(-1)?.status).toBe("✅ Готово\n\nОсь");
		expect(t.n.images).toEqual([{ chatId: 1, images: [{ source: "/tmp/a.png", caption: "графік" }] }]);
	});

	it("без поста підсумок іде окремим повідомленням з кнопкою", async () => {
		const t = await setup();
		t.post.posts.show = async () => false;
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await t.watcher.tick();
		expect(t.n.sent).toEqual([{ id: "s1", text: "✅ Готово\n\nЗроблено", kind: "mergeable" }]);
	});
});

describe("Watcher: потік подій", () => {
	const call = (name: string, input: Record<string, unknown>): OpencodeEvent[] => [
		{ type: "session.tool.input.started", data: { sessionID: "oc1", id: "c1", name } },
		{ type: "session.tool.called", data: { sessionID: "oc1", id: "c1", input } },
	];

	async function run(events: OpencodeEvent[], tracked?: Tracked) {
		const t = await setup({ events, tracked });
		await t.store.saveWatch("s1", { ...target, ocId: "oc1", since: 0, seenBusy: true });
		await t.watcher.watch("s1", target);
		await new Promise((r) => setTimeout(r, 20));
		return t;
	}

	it("завершення ходу одразу показує підсумок", async () => {
		const t = await run([{ type: "session.execution.succeeded", data: { sessionID: "oc1" } }]);
		expect(t.post.shown.at(-1)?.status).toBe("✅ Готово\n\nЗроблено");
	});

	it("питання агента показується з кнопками", async () => {
		const t = await run([{ type: "form.created", data: { form: { id: "f1", sessionID: "oc1", title: "?", fields: [{ key: "k", type: "boolean" }] } } }]);
		expect((await t.store.form("s1"))?.choices.map((c) => c.label)).toEqual(["Так", "Ні"]);
		expect(t.post.icons).toContain("question");
	});

	it("request-mcp, set-repo і handoff у виклику bash", async () => {
		const t = await run([
			...call("bash", { command: "request-mcp silpo" }),
			...call("bash", { command: "set-repo acme/new" }),
			{ type: "session.tool.input.started", data: { sessionID: "oc1", id: "c2", name: "bash" } },
			{ type: "session.tool.called", data: { sessionID: "oc1", id: "c2", input: { command: "handoff <<'EOF'\nЗроби X\nEOF" } } },
		], { ocId: "oc1", post: session.post });
		expect(t.n.mcpQuestions).toEqual([{ id: "s1", name: "silpo", threadId: 9 }]);
		expect((await t.store.session("s1"))?.repo).toBe("acme/new");
		expect(t.handoffs.spawned).toEqual([{ ocId: "oc1", callId: "c2", handoff: { task: "Зроби X" } }]);
	});
});

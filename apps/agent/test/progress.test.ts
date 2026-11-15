import type { Llm } from "@voice-notes/core";
import { describe, expect, it } from "vitest";
import { Forms, Progress } from "../src/application/progress";
import type { Watch } from "../src/domain/agent";
import { fakeOpencode, fakePosts, fakeStore } from "./fake-ports";

const watch: Watch = { chatId: 1, url: "u", postId: 5, threadId: 9, title: "Тема", header: "Завдання", ocId: "oc1", since: 0, seenBusy: true };
// Модель мовчить: опис дії лишається технічним підписом
const llm = (status?: string): Llm => ({ askJson: async (_r, parse) => (status ? parse(JSON.stringify({ status })) : null), transcribe: async () => "" });

async function setup(opts: { llm?: Llm; progressMs?: number; enabled?: boolean } = {}) {
	const store = fakeStore();
	const post = fakePosts();
	const { client } = fakeOpencode();
	await store.saveWatch("s1", watch);
	await store.saveSession("s1", { ocId: "oc1", post: { postId: 5, header: "Завдання", chatId: 1, url: "u", threadId: 9, title: "Тема" } });
	const forms = new Forms(store, post.posts, client);
	const progress = new Progress({ enabled: opts.enabled ?? true, llm: opts.llm ?? llm(), progressMs: opts.progressMs ?? 1000 }, store, post.posts, forms);
	return { store, post, progress };
}

describe("Progress", () => {
	it("показує поточну дію в пості, а наступну в межах інтервалу пропускає", async () => {
		const { progress, post } = await setup();
		progress.toolStarted("c1", "read");
		const tool = progress.toolCalled("oc1", "c1", { filePath: "/workspace/sessions/a/src/x.ts" });
		await progress.show("oc1", tool, { filePath: "/workspace/sessions/a/src/x.ts" });
		await progress.show("oc1", tool, { filePath: "y" });
		expect(post.shown).toHaveLength(1);
		expect(post.shown[0].status).toContain("⏳");
	});

	it("без бота нічого не показує", async () => {
		const { progress, post } = await setup({ enabled: false });
		await progress.show("oc1", "read", {});
		expect(post.shown).toEqual([]);
	});

	it("питання з варіантами: зберігає форму, показує кнопки й іконку питання", async () => {
		const { progress, post, store } = await setup();
		await progress.ask({ id: "f1", sessionID: "oc1", title: "Обери", fields: [{ key: "k", type: "string", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] });
		expect((await store.form("s1"))?.choices.map((c) => c.label)).toEqual(["A", "B"]);
		expect(post.shown.at(-1)?.answers?.labels).toEqual(["A", "B"]);
		expect(post.icons).toEqual(["question"]);
	});

	it("назва теми оновлюється лише після ✅", async () => {
		const { progress, post } = await setup({ llm: llm("Нова назва") });
		await progress.retitle("s1", watch, "❌ збій");
		expect(post.renames).toEqual([]);
	});
});

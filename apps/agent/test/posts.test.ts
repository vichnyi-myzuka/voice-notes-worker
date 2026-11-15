import { describe, expect, it } from "vitest";
import { HEADER_FINAL_MAX, Posts } from "../src/application/progress";
import type { WatchTarget } from "../src/domain/agent";
import { fakePostChat, fakePostStore, fakeStore } from "./fake-ports";

const target: WatchTarget = { chatId: 1, url: "https://x/s/s1", postId: 7, threadId: 3, header: "Завдання" };

function setup(enabled = true) {
	const chat = fakePostChat(enabled);
	const records = fakePostStore();
	const store = fakeStore();
	return { ...chat, records, store, posts: new Posts(chat.chat, records, store) };
}

describe("Posts", () => {
	it("поки сесія працює — кнопки «Стоп», підсумок — «Видалити», PR — «Змерджити», ліміти — «Повторити»", async () => {
		const { posts, edits } = setup();
		await posts.show("s1", target, "⏳ Працює");
		await posts.show("s1", target, "✅ Готово", true);
		await posts.show("s1", target, "✅ Готово", true, undefined, true);
		await posts.show("s1", target, "⏳ ліміт", true, undefined, true, true);
		expect(edits.map((e) => e.buttons)).toEqual(["working", "done", "mergeable", "retry"]);
		expect(edits[0].text).toBe("Завдання\n\n⏳ Працює");
		expect(edits[0].session).toEqual({ id: "s1", url: target.url });
	});

	it("без бота чи поста нічого не робить", async () => {
		expect(await setup(false).posts.show("s1", target, "x")).toBe(false);
		const { posts, edits } = setup();
		expect(await posts.show("s1", { ...target, postId: undefined }, "x")).toBe(false);
		expect(edits).toEqual([]);
	});

	it("з підсумком довга шапка скорочується", async () => {
		const { posts } = setup();
		const text = posts.text({ ...target, header: "а".repeat(HEADER_FINAL_MAX + 50) }, "✅", true);
		expect(text.startsWith("а".repeat(HEADER_FINAL_MAX) + "…")).toBe(true);
	});

	it("фінальний стан ставить іконку теми", async () => {
		const { posts, icons } = setup();
		await posts.show("s1", target, "✅ Готово", true);
		await posts.show("s1", target, "❌ збій", true);
		expect(icons).toEqual(["done", "failed"]);
	});

	it("деплой за гілкою дописується в пост сесії і прив'язує репозиторій", async () => {
		const { posts, store, edits, icons } = setup();
		await store.saveSession("s1", { ocId: "oc", post: { postId: 7, header: "Завдання", chatId: 1, url: target.url, threadId: 3 } });
		expect(await posts.setDeploy("acme/app", "s1", { text: "🚀 схвалити?", stage: "approval", repo: "acme/app", runId: 5 })).toBe(true);
		expect((await store.session("s1"))?.repo).toBe("acme/app");
		expect(edits.at(-1)).toMatchObject({ buttons: "done", review: { repo: "acme/app", runId: 5 } });
		expect(edits.at(-1)?.text).toContain("🚀 схвалити?");
		expect(icons).toContain("approval");
		await posts.setDeployByPost(7, { text: "✅ задеплоєно", stage: "deployed", done: true });
		expect(edits.at(-1)?.buttons).toBe("dismiss");
		expect(edits.at(-1)?.text).not.toContain("Готово");
	});

	it("деплой іншої гілки не знаходить сесії, а сторонній пост без деплою ігнорується", async () => {
		const { posts, store } = setup();
		await store.saveSession("s1", { ocId: "oc", post: { postId: 7, header: "", chatId: 1, url: "u" } });
		expect(await posts.setDeploy("acme/app", "other", { text: "x" })).toBe(false);
		expect(await posts.setDeployByPost(7, { text: "x" })).toBe(false);
	});

	it("після зміни репозиторію й моделі шапка перебудовується, а пост перемальовується з тим самим станом", async () => {
		const { posts, store, edits } = setup();
		const parts = { tail: "«задача»" };
		await store.saveSession("s1", { ocId: "oc", folder: "fix-1", post: { postId: 7, header: "«задача»", parts, chatId: 1, url: target.url, threadId: 3 } });
		await posts.show("s1", { ...target, header: "«задача»" }, "⏳ Працює");
		await store.saveSession("s1", { ...(await store.session("s1"))!, repo: "acme/app" });
		expect(await posts.refreshHeader("s1")).toBe(true);
		expect(edits.at(-1)?.text).toBe("📦 acme/app\n🌿 agent/fix-1\n\n«задача»\n\n⏳ Працює");
		await store.saveSession("s1", { ...(await store.session("s1"))!, model: "opus" });
		await posts.refreshHeader("s1");
		expect(edits.at(-1)?.text).toBe("📦 acme/app\n🌿 agent/fix-1\n🤖 opus\n\n«задача»\n\n⏳ Працює");
		expect(edits.at(-1)?.buttons).toBe("working");
		expect(await posts.refreshHeader("s1")).toBe(false); // нічого не змінилось
	});

	it("спостереження зі старою шапкою показує нову шапку зі сесії", async () => {
		const { posts, store, edits } = setup();
		await store.saveSession("s1", { ocId: "oc", model: "opus", post: { postId: 7, header: "🤖 opus", parts: {}, chatId: 1, url: target.url } });
		await posts.show("s1", { ...target, header: "стара" }, "✅ Готово", true);
		expect(edits.at(-1)?.text).toBe("🤖 opus\n\n✅ Готово");
	});

	it("сесія без збережених частин шапки (стара) не перемальовується", async () => {
		const { posts, store, edits } = setup();
		await store.saveSession("s1", { ocId: "oc", model: "opus", post: { postId: 7, header: "Завдання", chatId: 1, url: target.url } });
		expect(await posts.refreshHeader("s1")).toBe(false);
		expect(edits).toEqual([]);
	});

	it("посилання вебхука забираються один раз", async () => {
		const { posts } = setup();
		await posts.saveRef("k", { chatId: 1, messageId: 2, text: "t" });
		expect(await posts.takeRef("k")).toEqual({ chatId: 1, messageId: 2, text: "t" });
		expect(await posts.takeRef("k")).toBeUndefined();
	});

	it("правки йдуть у черзі: settled чекає проміжну", async () => {
		const { posts } = setup();
		const order: number[] = [];
		void posts.enqueue(async () => { await Promise.resolve(); order.push(1); });
		await posts.settled();
		order.push(2);
		expect(order).toEqual([1, 2]);
	});
});

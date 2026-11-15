import { describe, expect, it } from "vitest";
import { Forms } from "../src/application/progress";
import type { PendingForm, Watch } from "../src/domain/agent";
import { fakeOpencode, fakePosts, fakeStore } from "./fake-ports";

const watch: Watch = { chatId: 1, url: "u", postId: 5, ocId: "oc1", since: 0, seenBusy: true };
const form = (over: Partial<PendingForm> = {}): PendingForm => ({ formId: "f1", ocId: "oc1", key: "k", choices: [{ label: "Так", value: true }, { label: "Ні", value: false }], selected: [], text: "Питання?", ...over });

async function setup(f: PendingForm | undefined) {
	const store = fakeStore();
	const { client, calls } = fakeOpencode();
	const post = fakePosts();
	await store.saveWatch("s1", watch);
	if (f) await store.saveForm("s1", f);
	return { store, calls, post, forms: new Forms(store, post.posts, client) };
}

describe("Forms", () => {
	it("відповідь кнопкою йде агентові, форма зникає, пост показує відповідь", async () => {
		const { forms, store, calls, post } = await setup(form());
		expect(await forms.answer("s1", 0)).toBe("Відповідь: Так");
		expect(calls.replies).toEqual([{ ocId: "oc1", formId: "f1", answer: { k: true } }]);
		expect(await store.form("s1")).toBeUndefined();
		expect(post.shown[0].status).toContain("відповідь: Так");
	});

	it("без питання відповідь неактуальна", async () => {
		const { forms } = await setup(undefined);
		expect(await forms.answer("s1", 0)).toBeUndefined();
	});

	it("багатокрокова форма: наступний крок з кнопками, агентові — після останнього", async () => {
		const { forms, store, calls, post } = await setup(form({ next: [{ key: "k2", choices: [{ label: "A", value: "a" }], text: "Друге?" }] }));
		await forms.answer("s1", 1);
		expect(calls.replies).toEqual([]);
		expect(post.shown[0]).toMatchObject({ status: "Друге?", answers: { labels: ["A"] } });
		expect((await store.form("s1"))?.answers).toEqual({ k: false });
		await forms.answer("s1", 0);
		expect(calls.replies[0].answer).toEqual({ k: false, k2: "a" });
	});

	it("множинний вибір: перемикання й підтвердження", async () => {
		const { forms, calls } = await setup(form({ multiple: true, choices: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }));
		expect(await forms.answer("s1", "ok")).toBe("Вибери хоча б один варіант.");
		expect(await forms.answer("s1", 1)).toBe("Вибрано: B");
		expect(await forms.answer("s1", 0)).toBe("Вибрано: A, B");
		expect(await forms.answer("s1", "ok")).toBe("Відповідь: A, B");
		expect(calls.replies[0].answer).toEqual({ k: ["a", "b"] });
	});

	it("текст замість кнопки скасовує питання", async () => {
		const { forms, store, calls, post } = await setup(form());
		await forms.cancel("s1", "інше");
		expect(calls.cancels).toEqual([{ ocId: "oc1", formId: "f1", message: "інше" }]);
		expect(await store.form("s1")).toBeUndefined();
		expect(post.shown[0].status).toContain("відповідь: інше");
	});
});

import { describe, expect, it } from "vitest";
import {
	buildThingsUrl,
	changedAttributes,
	createThingsLink,
	getInThings,
	handleThingsDone,
	handleThingsLink,
	planThingsOps,
	setThingsLinkMessage,
	snapshotFromForm,
	taskValidator,
	type InThings,
	type ThingsSnapshot,
	type TriageItem,
} from "../src/things";
import { fakeEnv } from "./fake-env";

const snap: ThingsSnapshot = {
	projects: ["Ремонт"],
	areas: ["Home", "Shopping", "Work", "Personal affairs"],
	todos: ["Купити молоко"],
};
const item = (title: string, extra: Partial<TriageItem> = {}): TriageItem => ({
	title,
	duplicateOf: "",
	list: "",
	tags: [],
	when: "",
	deadline: "",
	...extra,
});
type Op = { type: string; operation?: string; id?: string; attributes: Record<string, unknown> };
const decode = (url: string) => {
	const q = new URLSearchParams(url.split("?")[1]);
	return { q, data: JSON.parse(q.get("data")!) as Op[] };
};
// things:///json з HTML-сторінки посилання
const href = async (res: Response) =>
	(await res.text()).match(/things:\/\/\/json\?[^"]+/)![0].replaceAll("&amp;", "&");
const done = (env: ReturnType<typeof fakeEnv>, id: string, ids: string[]) =>
	handleThingsDone(env, id, new URL(`https://worker.test/things/${id}/done?x-things-ids=${encodeURIComponent(JSON.stringify(ids))}`));

describe("snapshotFromForm", () => {
	it("рядки без порожніх і повторів; без жодного поля — null", () => {
		const f = new FormData();
		f.set("areas", "Home\r\n\nWork\nHome");
		expect(snapshotFromForm(f)).toEqual({ projects: [], areas: ["Home", "Work"], todos: [] });
		expect(snapshotFromForm(new FormData())).toBeNull();
	});
});

describe("taskValidator", () => {
	const v = taskValidator(snap);
	it("тег, що збігається з областю, відкидається", () => {
		expect(v({ title: "Полагодити кран", list: "Home", tags: ["Home", "High"] }).tags).toEqual(["High"]);
	});
	it("задача з тегами без області й дати → when=anytime (не Inbox)", () => {
		expect(v({ title: "Х", list: "", tags: ["Errand"], when: "" }).when).toBe("anytime");
	});
	it("без області й тегів лишається Inbox", () => {
		expect(v({ title: "Х", list: "", tags: [], when: "" })).toMatchObject({ list: "", when: "" });
	});
	it("дублікат приводиться до точної назви з Things", () => {
		expect(v({ title: "Х", duplicate_of: "  купити   МОЛОКО " }).duplicateOf).toBe("Купити молоко");
	});
	it("невалідні дати відкидаються", () => {
		expect(v({ title: "Х", list: "Work", when: "наступного тижня", deadline: "2026-13" })).toMatchObject({ when: "", deadline: "" });
	});
});

describe("changedAttributes / planThingsOps", () => {
	const inThings: InThings = {
		t1: { thingsId: "A", item: item("Скасувати зустріч", { key: "t1", list: "Work", when: "2026-11-12" }) },
		t2: { thingsId: "B", item: item("Відмінити Netflix", { key: "t2", list: "Personal affairs" }) },
		t3: { thingsId: "C", item: item("Без змін", { key: "t3", list: "Home" }) },
	};
	it("лише змінені поля; прибрана дата → anytime, прибраний дедлайн → ''", () => {
		expect(changedAttributes(item("a", { when: "today", deadline: "2026-11-20" }), item("b"))).toEqual({
			title: "b",
			when: "anytime",
			deadline: "",
		});
	});
	it("оновлює змінені, пропускає незмінені, створює нові, скасовує прибрані, не створює дублікати", () => {
		const ops = planThingsOps(
			[
				item("Скасувати зустріч", { key: "t1", list: "Work", when: "today" }),
				item("Без змін", { key: "t3", list: "Home" }),
				item("Купити квіти", { key: "t4", list: "Shopping" }),
				item("Купити молоко", { key: "t5", duplicateOf: "Купити молоко" }),
			],
			inThings,
		);
		expect(ops).toEqual([
			{ key: "t1", item: expect.objectContaining({ when: "today" }), thingsId: "A", attributes: { when: "today" } },
			{ key: "t4", item: expect.objectContaining({ title: "Купити квіти" }) },
			{ key: "t2", item: null, thingsId: "B", attributes: { canceled: true } },
		]);
	});
});

describe("buildThingsUrl", () => {
	it("create з полями, update за id; auth-token і x-success лише коли передані", () => {
		const url = buildThingsUrl(
			[
				{ key: "t1", item: item("Нова", { list: "Work", tags: ["High"] }) },
				{ key: "t2", item: null, thingsId: "B", attributes: { canceled: true } },
			],
			"🎙 нотатка",
			"tok",
			"https://worker.test/things/x/done",
		);
		const { q, data } = decode(url);
		expect(url.startsWith("things:///json?")).toBe(true);
		expect(q.get("auth-token")).toBe("tok");
		expect(q.get("x-success")).toBe("https://worker.test/things/x/done");
		expect(data).toEqual([
			{ type: "to-do", attributes: { title: "Нова", notes: "🎙 нотатка", list: "Work", tags: ["High"] } },
			{ type: "to-do", operation: "update", id: "B", attributes: { canceled: true } },
		]);
		expect(decode(buildThingsUrl([], "", "")).q.has("auth-token")).toBe(false);
	});
});

describe("посилання Things: відкриття, x-success, оновлення", () => {
	it("повний цикл: створення → ID з x-success → оновлення й скасування за ID", async () => {
		const env = fakeEnv({ THINGS_AUTH_TOKEN: "tok" });
		const id = await createThingsLink(
			env,
			[
				{ key: "t1", item: item("А", { list: "Work" }) },
				{ key: "t2", item: item("Б") },
			],
			"🎙 н",
			"note1",
		);
		await setThingsLinkMessage(env, id, "https://t.me/c/1/5");

		const first = decode(await href(await handleThingsLink(env, id, false)));
		expect(first.q.has("auth-token")).toBe(false); // лише створення
		expect(first.q.get("x-success")).toBe(`https://worker.test/things/${id}/done`);
		expect(first.data[0].attributes.notes).toBe("🎙 н\nhttps://t.me/c/1/5");
		expect(await (await handleThingsLink(env, id, false)).text()).toContain("Вже відкривалось");

		await done(env, id, ["ID1", "ID2"]);
		const state = await getInThings(env, "note1");
		expect(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.thingsId]))).toEqual({ t1: "ID1", t2: "ID2" });

		// повторний x-success нічого не змінює
		await done(env, id, ["X"]);
		expect((await getInThings(env, "note1")).t1.thingsId).toBe("ID1");

		const upd = await createThingsLink(env, planThingsOps([item("А", { key: "t1", list: "Work", when: "today" })], state), "🎙 н", "note1");
		const second = decode(await href(await handleThingsLink(env, upd, false)));
		expect(second.q.get("auth-token")).toBe("tok");
		expect(second.data).toEqual([
			{ type: "to-do", operation: "update", id: "ID1", attributes: { when: "today" } },
			{ type: "to-do", operation: "update", id: "ID2", attributes: { canceled: true } },
		]);

		await done(env, upd, []);
		const after = await getInThings(env, "note1");
		expect(Object.keys(after)).toEqual(["t1"]);
		expect(after.t1.item.when).toBe("today");
	});

	it("оновлення без THINGS_AUTH_TOKEN — зрозуміла помилка", async () => {
		const env = fakeEnv();
		const id = await createThingsLink(env, [{ key: "t1", item: null, thingsId: "A", attributes: { canceled: true } }], "н", "n");
		const res = await handleThingsLink(env, id, false);
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("THINGS_AUTH_TOKEN");
	});

	it("старий формат посилання (items без ops) ще відкривається", async () => {
		const env = fakeEnv();
		env.store.set("things/old.json", JSON.stringify({ items: [item("Стара")], notes: "н" }));
		const { data, q } = decode(await href(await handleThingsLink(env, "old", false)));
		expect(data[0].attributes.title).toBe("Стара");
		expect(q.has("x-success")).toBe(false);
	});
});

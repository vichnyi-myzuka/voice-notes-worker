import { afterEach, describe, expect, it, vi } from "vitest";
import { openSteps } from "../src/infrastructure/steps";
import { getTrackedTasks, syncTasks, type SyncState } from "../src/application/tasks";
import type { TriageItem } from "../src/domain/tracker";
import { RULES_PROJECT, todoistTracker } from "../src/infrastructure/todoist";
import { fakeEnv } from "./fake-env";

const item = (title: string, key: string, extra: Partial<TriageItem> = {}): TriageItem => ({
	title,
	key,
	duplicateOf: "",
	project: "",
	labels: [],
	priority: 4,
	due: "",
	deadline: "",
	...extra,
});

const raw = {
	projects: [
		{ id: "inbox-id", name: "Inbox", inbox_project: true },
		{ id: "rules-id", name: RULES_PROJECT, description: "[правила]" },
	],
	labels: [],
	items: [],
};
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// Лічильник запитів до Todoist.
function stubTodoist() {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (url: string) => {
		calls.push(url);
		return json(raw);
	});
	return calls;
}

const KEY = "k.state.json";
const args = (items: TriageItem[] | null) => ({ noteId: "n1", items, description: "опис", messageUrl: "https://t.me/c/1/2" });

afterEach(() => vi.unstubAllGlobals());

describe("syncTasks", () => {
	it("без змін повертає undefined і не торкається Todoist", async () => {
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const calls = stubTodoist();
		const steps = await openSteps<SyncState>(env, KEY, false);
		expect(await syncTasks(env, todoistTracker(env), steps, args(null))).toBeUndefined();
		expect(await syncTasks(env, todoistTracker(env), steps, args([item("Дубль", "t1", { duplicateOf: "Купити молоко" })]))).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(steps.state.actionId).toBeUndefined();
	});

	it("створює задачі, зберігає ops, id запуску й результат", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const steps = await openSteps<SyncState>(env, KEY, false);
		const a = item("Перша", "t1");
		// id запуску створюється кроком actionId, тож статуси команд будуємо вже в момент запису
		vi.stubGlobal("fetch", async (_u: string, init: { body: URLSearchParams }) => {
			const cmds = init.body.get("commands");
			if (!cmds) return json(raw);
			const id = steps.state.actionId!;
			return json({ sync_status: { [`${id}-0`]: "ok" }, temp_id_mapping: { [`tmp-${id}-0`]: "301" } });
		});

		expect(await syncTasks(env, todoistTracker(env), steps, args([a]))).toBe(true);
		expect(steps.state).toMatchObject({ ops: [{ key: "t1", item: a }], tasksApplied: true });
		expect(await getTrackedTasks(env, "n1")).toEqual({ t1: { id: "301", item: a } });
	});

	it("ретрай після збою пропускає виконане й шле ті самі uuid", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		const items = [item("Перша", "t1"), item("Друга", "t2")];

		const first = await openSteps<SyncState>(env, KEY, false);
		let id = "";
		vi.stubGlobal("fetch", async (_u: string, init: { body: URLSearchParams }) => {
			if (!init.body.get("commands")) return json(raw);
			id = first.state.actionId!;
			return json({ sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: { error_code: 15, error: "Fail" } }, temp_id_mapping: { [`tmp-${id}-0`]: "301" } });
		});
		await expect(syncTasks(env, todoistTracker(env), first, args(items))).rejects.toThrow(/Task tracker commands failed/);

		// Нова спроба: у Todoist уже є перша задача, але ops і uuid лишаються тими самими.
		const second = await openSteps<SyncState>(env, KEY, false);
		const calls: { uuid: string }[][] = [];
		vi.stubGlobal("fetch", async (_u: string, init: { body: URLSearchParams }) => {
			const cmds = init.body.get("commands");
			if (!cmds) return json(raw);
			calls.push(JSON.parse(cmds));
			return json({ sync_status: { [`${id}-0`]: "ok", [`${id}-1`]: "ok" }, temp_id_mapping: { [`tmp-${id}-1`]: "302" } });
		});
		expect(await syncTasks(env, todoistTracker(env), second, args(items))).toBe(true);
		expect(second.state.actionId).toBe(id);
		expect(calls[0].map((c) => c.uuid)).toEqual([`${id}-0`, `${id}-1`]);
	});

	it("на останній спробі збій Todoist дає false, а не помилку", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const env = fakeEnv({ TODOIST_TOKEN: "tok" });
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, text: async () => "boom" }));
		const steps = await openSteps<SyncState>(env, KEY, true);
		expect(await syncTasks(env, todoistTracker(env), steps, args([item("Перша", "t1")]))).toBe(false);
		expect(steps.state.tasksApplied).toBe(false);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { openSteps, type Llm } from "@voice-notes/core";
import { closeIssues, syncIssues, type IssueState } from "../src/application/issues";
import { planIssueOps } from "../src/application/issues/plan";
import type { TrackedIssues } from "../src/domain/issues";
import type { TriageItem } from "../src/domain/tracker";
import { githubIssues, parseRepos } from "../src/infrastructure/github";
import { r2IssueLedger } from "../src/infrastructure/r2";
import { fakeEnv } from "./fake-env";

const REPOS = JSON.stringify([{ repo: "me/bot", description: "voice notes bot" }]);
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
const tracked = (title: string, details = ""): TrackedIssues[string] => ({ repo: "me/bot", number: 7, url: "https://github.com/me/bot/issues/7", title, details });

afterEach(() => vi.unstubAllGlobals());

describe("planIssueOps", () => {
	it("створює нові задачі проєкту, пропускає решту й дублікати", () => {
		const items = [item("Додати issues", "t1"), item("Купити молоко", "t2"), item("Дубль", "t3", { duplicateOf: "X" })];
		expect(planIssueOps(items, {}, { t1: "me/bot", t3: "me/bot" })).toEqual([{ kind: "create", key: "t1", repo: "me/bot", title: "Додати issues", details: "" }]);
	});

	it("оновлює змінені, не чіпає незмінені, закриває прибрані", () => {
		const prev = { t1: tracked("Стара назва"), t2: tracked("Та сама"), t3: tracked("Прибрана") };
		const items = [item("Нова назва", "t1"), item("Та сама", "t2")];
		expect(planIssueOps(items, prev, {})).toEqual([
			{ kind: "update", key: "t1", title: "Нова назва", details: "" },
			{ kind: "close", key: "t3" },
		]);
	});
});

describe("parseRepos", () => {
	it("відкидає некоректні записи й сміття", () => {
		expect(parseRepos(REPOS)).toHaveLength(1);
		expect(parseRepos(JSON.stringify([{ repo: "bad", description: "x" }, { repo: "a/b" }]))).toEqual([]);
		expect(parseRepos("не json")).toEqual([]);
		expect(parseRepos(undefined)).toEqual([]);
	});
});

// Мок GitHub: лічильник номерів і журнал запитів.
function stubGithub(failOn?: string) {
	const calls: string[] = [];
	let n = 0;
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const call = `${init.method} ${url.replace("https://api.github.com", "")}`;
		calls.push(call);
		if (failOn && call.includes(failOn)) return { ok: false, status: 500, text: async () => "boom" };
		n++;
		return { ok: true, status: 200, json: async () => ({ number: 100 + n, html_url: `https://github.com/me/bot/issues/${100 + n}` }) };
	});
	return calls;
}

const llmAnswering = (items: { key: string; repo: string }[]): Llm & { asked: number } => ({
	asked: 0,
	transcribe: async () => "",
	async askJson(_req, parse) {
		this.asked++;
		return parse(JSON.stringify({ items }));
	},
});

const KEY = "k.state.json";
const args = (items: TriageItem[] | null) => ({ noteId: "n1", items, description: "Нотатка (дата)", messageUrl: "https://t.me/c/1/2" });
const portsFor = (env: ReturnType<typeof fakeEnv>, llm: Llm) => ({ issues: githubIssues(env), issueLedger: r2IssueLedger(env), llm });

describe("syncIssues", () => {
	it("вимкнений без токена чи репозиторіїв: модель і GitHub не викликаються", async () => {
		const calls = stubGithub();
		const llm = llmAnswering([]);
		for (const env of [fakeEnv({ ISSUE_REPOS: REPOS }), fakeEnv({ GITHUB_ISSUES_TOKEN: "t" })]) {
			const run = await openSteps<IssueState>(env, KEY, false);
			expect(await syncIssues(portsFor(env, llm), run, args([item("Додати issues", "t1")]))).toBeUndefined();
		}
		expect(calls).toHaveLength(0);
		expect(llm.asked).toBe(0);
	});

	it("створює issue лише для задач проєкту й пише посилання на нотатку в тіло", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const env = fakeEnv({ GITHUB_ISSUES_TOKEN: "t", ISSUE_REPOS: REPOS });
		const bodies: string[] = [];
		const calls = stubGithub();
		const base = globalThis.fetch;
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => (bodies.push(String(init.body)), base(url, init)));
		const llm = llmAnswering([{ key: "t1", repo: "me/bot" }, { key: "t2", repo: "" }]);
		const run = await openSteps<IssueState>(env, KEY, false);
		const items = [item("Додати issues", "t1", { details: "Через REST" }), item("Купити молоко", "t2")];
		expect(await syncIssues(portsFor(env, llm), run, args(items))).toBe(true);
		expect(calls).toEqual(["POST /repos/me/bot/issues"]);
		expect(JSON.parse(bodies[0])).toEqual({ title: "Додати issues", body: "Через REST\n\n🎙 Нотатка (дата)\n\nhttps://t.me/c/1/2" });
		expect(await r2IssueLedger(env).get("n1")).toMatchObject({ t1: { repo: "me/bot", number: 101, title: "Додати issues" } });
	});

	it("ігнорує репозиторій, якого немає в налаштуваннях", async () => {
		const env = fakeEnv({ GITHUB_ISSUES_TOKEN: "t", ISSUE_REPOS: REPOS });
		const calls = stubGithub();
		const run = await openSteps<IssueState>(env, KEY, false);
		expect(await syncIssues(portsFor(env, llmAnswering([{ key: "t1", repo: "evil/repo" }])), run, args([item("Додати", "t1")]))).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("правка: оновлює змінену issue, закриває прибрану, не питає модель про вже створені", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const env = fakeEnv({ GITHUB_ISSUES_TOKEN: "t", ISSUE_REPOS: REPOS });
		const ledger = r2IssueLedger(env);
		await ledger.save("n1", { t1: tracked("Стара"), t2: { ...tracked("Прибрана"), number: 8 } });
		const calls = stubGithub();
		const llm = llmAnswering([]);
		const run = await openSteps<IssueState>(env, KEY, false);
		expect(await syncIssues(portsFor(env, llm), run, args([item("Нова", "t1")]))).toBe(true);
		expect(calls).toEqual(["PATCH /repos/me/bot/issues/7", "POST /repos/me/bot/issues/8/comments", "PATCH /repos/me/bot/issues/8"]);
		expect(llm.asked).toBe(0);
		expect(Object.keys(await ledger.get("n1"))).toEqual(["t1"]);
	});

	it("ретрай після часткового збою не створює issue вдруге", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const env = fakeEnv({ GITHUB_ISSUES_TOKEN: "t", ISSUE_REPOS: REPOS });
		const llm = llmAnswering([{ key: "t1", repo: "me/bot" }, { key: "t2", repo: "me/bot" }]);
		const items = [item("Перша", "t1"), item("Друга", "t2")];
		// Друге створення падає, перше вже в книзі.
		let created = 0;
		vi.stubGlobal("fetch", async () => {
			if (++created === 2) return { ok: false, status: 500, text: async () => "boom" };
			return { ok: true, status: 200, json: async () => ({ number: created, html_url: `https://github.com/me/bot/issues/${created}` }) };
		});
		const first = await openSteps<IssueState>(env, KEY, false);
		await expect(syncIssues(portsFor(env, llm), first, args(items))).rejects.toThrow(/GitHub issues failed/);
		const calls = stubGithub();
		const second = await openSteps<IssueState>(env, KEY, true);
		expect(await syncIssues(portsFor(env, llm), second, args(items))).toBe(true);
		expect(calls).toEqual(["POST /repos/me/bot/issues"]); // лише друга
		expect(llm.asked).toBe(1); // класифікація збережена кроком
	});

	it("на останній спробі збій GitHub дає false, а не падіння", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const env = fakeEnv({ GITHUB_ISSUES_TOKEN: "t", ISSUE_REPOS: REPOS });
		stubGithub("/issues");
		const run = await openSteps<IssueState>(env, KEY, true);
		expect(await syncIssues(portsFor(env, llmAnswering([{ key: "t1", repo: "me/bot" }])), run, args([item("Додати", "t1")]))).toBe(false);
	});
});

describe("closeIssues", () => {
	it("закриває всі issues нотатки й чистить книгу", async () => {
		const env = fakeEnv({ GITHUB_ISSUES_TOKEN: "t", ISSUE_REPOS: REPOS });
		const ledger = r2IssueLedger(env);
		await ledger.save("n1", { t1: tracked("A"), t2: { ...tracked("B"), number: 8 } });
		const calls = stubGithub();
		expect(await closeIssues(portsFor(env, llmAnswering([])), "n1")).toBe(2);
		expect(calls).toEqual(["POST /repos/me/bot/issues/7/comments", "PATCH /repos/me/bot/issues/7", "POST /repos/me/bot/issues/8/comments", "PATCH /repos/me/bot/issues/8"]);
		expect(await ledger.get("n1")).toEqual({});
	});
});

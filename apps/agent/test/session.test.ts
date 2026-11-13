import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// У Node немає модуля cloudflare:workers: підставляємо мінімальний DurableObject.
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

const { AgentSession } = await import("../src/infrastructure/container/session");

// «Контейнер» з OpenCode, що відповідає на ті самі запити, що й справжній.
function fakeContainer() {
	const opencode = { sessions: new Set<string>(), prompts: [] as { id: string; text: string }[], busy: new Set<string>(), aborted: [] as string[], deleted: [] as string[], seq: 0, requests: [] as string[], auths: new Set<string>(), directories: [] as string[], events: [] as ReadableStreamDefaultController<Uint8Array>[], emit(event: unknown) { for (const c of opencode.events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); }, execs: [] as { cmd: string[]; env?: Record<string, string> }[], syncs: [] as { path: string; mode: string; content: string }[][], execFails: false, info: {} as Record<string, Record<string, unknown>>, lastText: "", lastError: "", procNet: "", origins: [] as string[], tickets: [] as string[], execActive: 0, execMax: 0, models: [] as unknown[], switches: [] as { id: string; model: unknown }[], formReplies: [] as { path: string; body: unknown }[], formCancels: [] as string[], connected: false, modelChecks: 0, modelsAfter: 0 };
	const container = {
		running: false,
		images: { base: "image" },
		starts: [] as Record<string, unknown>[],
		snapshots: new Map<string, { sessions: string[] }>(),
		failRestore: false,
		broken: false, // відновлення зі знімка не вдалося: OpenCode не відповідає
		start(options: Record<string, unknown>) {
			container.running = true;
			container.starts.push(options);
			const snapshot = options.containerSnapshot as { id: string } | undefined;
			if (snapshot) {
				if (container.failRestore) container.broken = true;
				else for (const id of container.snapshots.get(snapshot.id)!.sessions) opencode.sessions.add(id);
			}
		},
		async snapshotContainer(options: { name?: string }) {
			if (!options) throw new TypeError("options required");
			const id = `snap${container.snapshots.size + 1}`;
			container.snapshots.set(id, { sessions: [...opencode.sessions] });
			return { id, size: 1, name: options.name };
		},
		async destroy() {
			container.running = false;
			container.broken = false;
			opencode.sessions.clear();
			opencode.busy.clear();
		},
		monitor: () => new Promise<void>(() => {}),
		setInactivityTimeout: async () => {},
		// exec не успадковує env контейнера; session-prep друкує шлях теки сесії.
		async exec(cmd: string[], options?: { env?: Record<string, string> }) {
			if (cmd[0] === "node") {
				// розкладання payload/: окремо від решти, щоб не заважати перевіркам session-prep
				opencode.syncs.push(JSON.parse(options!.env!.PAYLOAD) as { path: string; mode: string; content: string }[]);
				return { output: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }) };
			}
			opencode.execs.push({ cmd, env: options?.env });
			opencode.execMax = Math.max(opencode.execMax, ++opencode.execActive);
			await Promise.resolve();
			opencode.execActive--;
			return {
				output: async () => ({
					exitCode: opencode.execFails ? 1 : 0,
					stdout: new TextEncoder().encode(cmd[0] === "cat" ? opencode.procNet : `/workspace/sessions/${cmd[1]}\n`),
					stderr: new TextEncoder().encode(opencode.execFails ? "fatal: repository not found" : ""),
				}),
			};
		},
		// Контейнер заснув: процес зник разом із диском.
		sleep() {
			container.running = false;
			opencode.sessions.clear();
			opencode.busy.clear();
		},
		getTcpPort: () => ({
			fetch: async (input: string | Request, init?: RequestInit) => {
				if (container.broken) throw new Error("connection refused");
				const req = new Request(input, init);
				const path = new URL(req.url).pathname;
				opencode.requests.push(`${req.method} ${path}`);
				opencode.auths.add(req.headers.get("authorization") ?? "");
				if (req.headers.has("origin")) opencode.origins.push(req.headers.get("origin")!);
				if (req.headers.has("x-opencode-ticket")) opencode.tickets.push(req.headers.get("x-opencode-ticket")!);
				const ok = (data: unknown) => Response.json({ data });
				if (path === "/api/event") {
					return new Response(new ReadableStream<Uint8Array>({ start: (c) => void opencode.events.push(c) }), { headers: { "content-type": "text/event-stream" } });
				}
				if (path === "/api/info") return Response.json({ version: "2.2.7" });
				if (req.method === "POST" && path === "/api/session") {
					const body = await req.json<{ title: string; location: { directory: string }; model?: unknown }>();
					opencode.models.push(body.model);
					const id = `ses_oc${++opencode.seq}`;
					opencode.sessions.add(id);
					opencode.directories.push(body.location.directory);
					return ok({ id });
				}
				if (req.method === "POST" && path === "/api/integration/claude-agent/connect/external") {
					opencode.connected = true;
					return new Response(null, { status: 204 });
				}
				if (req.method === "DELETE" && /^\/api\/session\/[^/]+\/form\/[^/]+$/.test(path)) {
					opencode.formCancels.push(`${path}?message=${new URL(req.url).searchParams.get("message")}`);
					return new Response(null, { status: 204 });
				}
				if (req.method === "POST" && /^\/api\/session\/[^/]+\/form\/[^/]+\/reply$/.test(path)) {
					opencode.formReplies.push({ path, body: await req.json() });
					return new Response(null, { status: 204 });
				}
				if (path === "/api/model") return ok(opencode.connected && ++opencode.modelChecks > opencode.modelsAfter ? [{ id: "sonnet", providerID: "claude-agent" }, { id: "opus", providerID: "claude-agent" }] : []);
				if (path === "/api/session/active") return ok(Object.fromEntries([...opencode.busy].map((id) => [id, { type: "running" }])));
				const sw = path.match(/^\/api\/session\/([^/]+)\/model$/);
				if (req.method === "POST" && sw) {
					opencode.switches.push({ id: sw[1], model: (await req.json<{ model: unknown }>()).model });
					return new Response(null, { status: 204 });
				}
				const m = path.match(/^\/api\/session\/([^/]+)(?:\/(prompt|interrupt))?$/);
				if (m && !opencode.sessions.has(m[1])) return new Response("not found", { status: 404 });
				if (req.method === "DELETE" && m && !m[2]) {
					opencode.sessions.delete(m[1]);
					opencode.deleted.push(m[1]);
					return new Response(null, { status: 204 });
				}
				if (m?.[2] === "prompt") {
					opencode.prompts.push({ id: m[1], text: (await req.json<{ text: string }>()).text });
					opencode.busy.add(m[1]);
					return ok({ id: "inbox1" });
				}
				if (m?.[2] === "interrupt") {
					opencode.aborted.push(m[1]);
					opencode.busy.delete(m[1]);
					return Response.json({ interrupted: true });
				}
				if (path.match(/^\/api\/session\/[^/]+\/message$/)) return ok([{ content: [{ type: "text", text: opencode.lastText }], ...(opencode.lastError && { error: { message: opencode.lastError } }) }]);
				if (m) return ok({ id: m[1], ...opencode.info[m[1]] });
				return new Response(`ui ${path}`);
			},
		}),
	};
	return { container, opencode };
}

function setup(extraEnv: Record<string, string> = {}) {
	const { container, opencode } = fakeContainer();
	const store = new Map<string, unknown>();
	const alarm = { at: null as number | null };
	const ctx = {
		container,
		storage: {
			get: async (k: string) => store.get(k),
			put: async (k: string, v: unknown) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
			getAlarm: async () => alarm.at,
			setAlarm: async (at: number) => void (alarm.at = at),
			list: async ({ prefix }: { prefix: string }) => new Map([...store].filter(([k]) => k.startsWith(prefix))),
		},
		blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
		waitUntil: () => {},
	};
	const env = { OPENCODE_PASSWORD: "pw", ANTHROPIC_API_KEY: "ak", GITHUB_TOKEN: undefined, ...extraEnv };
	const session = new AgentSession(ctx as unknown as DurableObjectState, env as never);
	return { session, container, opencode, store, alarm };
}

const ID = "session-0001";

beforeEach(() => vi.stubGlobal("scheduler", { wait: async () => {} }));

describe("AgentSession", () => {
	it("start: піднімає контейнер, створює сесію OpenCode й ставить задачу", async () => {
		const { session, container, opencode } = setup({ GITHUB_TOKEN: "gh" });
		const { sessionId } = await session.start(ID, { prompt: "Поправ README", repo: "me/app" });
		expect(sessionId).toBe("ses_oc1");
		expect(container.starts).toHaveLength(1);
		expect(container.starts[0]).toMatchObject({ enableInternet: true, env: { OPENCODE_PASSWORD: "pw", ANTHROPIC_API_KEY: "ak" } });
		// Порожні секрети в контейнер не передаються.
		expect(container.starts[0].env).toMatchObject({ GITHUB_TOKEN: "gh" });
		expect(container.starts[0].env).not.toHaveProperty("REPO"); // репозиторії готує session-prep, а не entrypoint
		expect(opencode.prompts).toEqual([{ id: "ses_oc1", text: "Поправ README" }]);
		// Тека сесії готується через exec (він не успадковує env контейнера, тож токен іде явно).
		expect(opencode.execs).toEqual([{ cmd: ["session-prep", ID, "me/app"], env: { HOME: "/root", GITHUB_TOKEN: "gh" } }]);
		expect(opencode.directories).toEqual([`/workspace/sessions/${ID}`]); // worktree сесії
		expect(opencode.auths).toEqual(new Set([`Basic ${btoa("opencode:pw")}`]));
	});

	it("з токеном підписки: токен іде в контейнер, Claude Agent підключається один раз за старт, сесії — з його моделлю", async () => {
		const { session, container, opencode } = setup({ CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_MODEL: "opus" });
		await session.start(ID, { prompt: "Задача" });
		expect(container.starts[0].env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		expect(opencode.requests.filter((r) => r.includes("connect/external"))).toHaveLength(1);
		expect(opencode.models).toEqual([{ providerID: "claude-agent", id: "opus" }]);
		container.sleep();
		await session.followUp(ID, "Ще раз"); // новий старт контейнера → підключення знову
		expect(opencode.requests.filter((r) => r.includes("connect/external"))).toHaveLength(2);
	});

	it("з токеном: чекає, поки моделі Claude Agent з'являться, і підключає провайдера лише раз", async () => {
		const { session, opencode } = setup({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		opencode.modelsAfter = 3; // перші перевірки моделей повертають порожній список
		await session.start(ID, { prompt: "Задача" });
		expect(opencode.modelChecks).toBe(4);
		expect(opencode.requests.filter((r) => r.includes("connect/external"))).toHaveLength(1);
		expect(opencode.models).toEqual([{ providerID: "claude-agent", id: "sonnet" }]);
	});

	it("модель сесії: задається при старті, змінюється setModel і зберігається для нової сесії OpenCode після сну", async () => {
		const { session, container, opencode } = setup({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		await session.start(ID, { prompt: "Задача", model: "opus" });
		expect(opencode.models).toEqual([{ providerID: "claude-agent", id: "opus" }]);
		expect(await session.setModel(ID, "sonnet")).toBe(true);
		expect(opencode.switches).toEqual([{ id: "ses_oc1", model: { providerID: "claude-agent", id: "sonnet" } }]);
		expect(await session.setModel(ID, "gpt-nope")).toBe(false); // моделі немає в списку
		expect(opencode.switches).toHaveLength(1);
		container.sleep();
		opencode.sessions.clear(); // диск не відновився
		await session.followUp(ID, "Ще раз");
		expect(opencode.models.at(-1)).toEqual({ providerID: "claude-agent", id: "sonnet" });
	});

	it("без токена підписки модель не задається й Claude Agent не підключається", async () => {
		const { session, opencode } = setup();
		await session.start(ID, { prompt: "Задача" });
		expect(opencode.models).toEqual([undefined]);
		expect(opencode.requests.some((r) => r.includes("connect/external"))).toBe(false);
	});

	it("start без репозиторію працює в порожній теці сесії й без токена в exec", async () => {
		const { session, opencode } = setup();
		await session.start(ID, { prompt: "Задача" });
		expect(opencode.execs).toEqual([{ cmd: ["session-prep", ID], env: { HOME: "/root" } }]);
		expect(opencode.directories).toEqual([`/workspace/sessions/${ID}`]);
	});

	it("кілька сесій: один контейнер, окремі теки й сесії OpenCode; їх підготовка йде по черзі", async () => {
		const { session, container, opencode } = setup();
		await Promise.all([session.start("session-0001", { prompt: "А", repo: "me/app" }), session.start("session-0002", { prompt: "Б", repo: "me/app" })]);
		expect(container.starts).toHaveLength(1);
		expect(opencode.directories.sort()).toEqual(["/workspace/sessions/session-0001", "/workspace/sessions/session-0002"]);
		expect(opencode.execMax).toBe(1); // паралельні клони одного репозиторію псують один одного
		expect(await session.link("session-0001")).toBe("ses_oc1");
		expect(await session.link("session-0002")).toBe("ses_oc2");
	});

	it("паралельні start з тим самим id створюють одну сесію", async () => {
		const { session, opencode } = setup();
		const [a, b] = await Promise.all([session.start(ID, { prompt: "Задача" }), session.start(ID, { prompt: "Задача" })]);
		expect(a.sessionId).toBe(b.sessionId);
		expect(opencode.seq).toBe(1);
		expect(opencode.prompts).toHaveLength(1);
	});

	it("start: помилка session-prep не лишає сесії й не ставить задачу", async () => {
		const { session, opencode } = setup();
		opencode.execFails = true;
		await expect(session.start(ID, { prompt: "Задача", repo: "me/app" })).rejects.toThrow(/session-prep failed.*repository not found/);
		expect(opencode.seq).toBe(0);
		expect(await session.link(ID)).toBeUndefined();
		opencode.execFails = false;
		expect((await session.start(ID, { prompt: "Задача", repo: "me/app" })).sessionId).toBe("ses_oc1"); // повтор спрацьовує
	});

	it("невідома сесія: link undefined, status stopped, followUp — помилка, abort нічого не робить", async () => {
		const { session } = setup();
		expect(await session.link(ID)).toBeUndefined();
		expect(await session.status(ID)).toBe("stopped");
		await expect(session.followUp(ID, "Привіт")).rejects.toThrow(/unknown session/);
		await session.abort(ID);
	});

	it("start ідемпотентний: повтор не створює другу сесію й не ставить задачу вдруге", async () => {
		const { session, container, opencode } = setup();
		await session.start(ID, { prompt: "Задача" });
		const again = await session.start(ID, { prompt: "Задача" });
		expect(again.sessionId).toBe("ses_oc1");
		expect(container.starts).toHaveLength(1);
		expect(opencode.seq).toBe(1);
		expect(opencode.prompts).toHaveLength(1);
	});

	it("status: working, поки агент зайнятий; idle після завершення; stopped, коли контейнер спить (і не будить його)", async () => {
		const { session, container, opencode } = setup();
		expect(await session.status(ID)).toBe("stopped");
		await session.start(ID, { prompt: "Задача" });
		expect(await session.status(ID)).toBe("working");
		opencode.busy.clear();
		expect(await session.status(ID)).toBe("idle");

		container.sleep();
		const startsBefore = container.starts.length;
		expect(await session.status(ID)).toBe("stopped");
		expect(container.starts).toHaveLength(startsBefore);
	});

	it("followUp: дописує в ту саму сесію OpenCode", async () => {
		const { session, opencode } = setup();
		await session.start(ID, { prompt: "Перша" });
		await session.followUp(ID, "Уточнення");
		expect(opencode.prompts).toEqual([
			{ id: "ses_oc1", text: "Перша" },
			{ id: "ses_oc1", text: "Уточнення" },
		]);
	});

	it("followUp після сну контейнера: старої сесії вже немає, тож створюється нова й контейнер стартує знову", async () => {
		const { session, container, opencode } = setup();
		await session.start(ID, { prompt: "Перша", repo: "me/app" });
		container.sleep();
		await session.followUp(ID, "Продовжуй");
		expect(container.starts).toHaveLength(2);
		expect(opencode.execs.map((e) => e.cmd)).toEqual([["session-prep", ID, "me/app"], ["session-prep", ID, "me/app"]]); // теку готуємо заново
		expect(opencode.prompts.at(-1)).toEqual({ id: "ses_oc2", text: "Продовжуй" });
		expect(await session.link(ID)).toBe("ses_oc2");
		expect(await session.status(ID)).toBe("working");
	});

	describe("файли з payload/ розкладаються воркером, а не лежать в образі", () => {
		it("при старті контейнера: інструкції (обидва шляхи), publish, session-prep і git-хук з правами", async () => {
			const { session, opencode } = setup();
			await session.start(ID, { prompt: "Задача" });
			expect(opencode.syncs).toHaveLength(1);
			const byPath = Object.fromEntries(opencode.syncs[0].map((f) => [f.path, f]));
			expect(Object.keys(byPath).sort()).toEqual(["/root/.claude/CLAUDE.md", "/root/.claude/skills/report-site/SKILL.md", "/root/.config/opencode/AGENTS.md", "/root/.config/opencode/opencode.json", "/root/.config/opencode/skills/report-site/SKILL.md", "/usr/local/bin/new-report-site", "/usr/local/bin/publish", "/usr/local/bin/session-prep", "/usr/local/lib/git-hooks/pre-push"]);
			expect(byPath["/usr/local/bin/publish"].mode).toBe("755");
			expect(byPath["/root/.config/opencode/AGENTS.md"].content).toContain("Publishing small static sites");
			expect(byPath["/root/.claude/CLAUDE.md"].content).toBe(byPath["/root/.config/opencode/AGENTS.md"].content);
			expect(byPath["/usr/local/bin/session-prep"].content.startsWith("#!/bin/sh")).toBe(true);
			expect(byPath["/root/.config/opencode/skills/report-site/SKILL.md"].content).toContain("name: report-site");
			expect(byPath["/usr/local/bin/new-report-site"].mode).toBe("755");
		});

		it("глобальний конфіг OpenCode: контекст 272k для моделей Claude Agent і автостиснення", async () => {
			const { session, opencode } = setup();
			await session.start(ID, { prompt: "Задача" });
			const file = opencode.syncs[0].find((f) => f.path === "/root/.config/opencode/opencode.json")!;
			const config = JSON.parse(file.content);
			expect(config.compaction.auto).toBe(true);
			for (const id of ["opus", "sonnet", "haiku", "fable"]) expect(config.providers["claude-agent"].models[id].limit.context).toBe(272000);
		});

		it("працюючий контейнер вдруге не оновлюється, якщо вміст той самий; після змін (інший хеш) оновлюється", async () => {
			const { session, opencode, store } = setup();
			await session.start(ID, { prompt: "Задача" });
			await session.followUp(ID, "Ще");
			expect(opencode.syncs).toHaveLength(1);
			store.set("payloadHash", "old"); // як після деплою зі зміненим AGENTS.md
			await session.followUp(ID, "І ще");
			expect(opencode.syncs).toHaveLength(2);
		});

		it("після сну (знімок міг бути до деплою) файли розкладаються знову", async () => {
			const { session, container, opencode } = setup();
			await session.start(ID, { prompt: "Задача" });
			container.sleep();
			await session.followUp(ID, "Продовжуй");
			expect(opencode.syncs).toHaveLength(2);
		});
	});

	it("start з назвою: тека й гілка за змістом задачі (<назва>-<номер>); remove й followUp користуються нею", async () => {
		const { session, opencode } = setup();
		const id = "tg--1001-18";
		await session.start(id, { prompt: "Задача", repo: "me/app", name: "docs-add" });
		expect(opencode.execs[0].cmd).toEqual(["session-prep", "docs-add-18", "me/app"]);
		expect(opencode.directories).toEqual(["/workspace/sessions/docs-add-18"]);
		await session.remove(id);
		expect(opencode.execs.at(-1)!.cmd.at(-1)).toBe("docs-add-18");
	});

	it("тема сесії: byThread знаходить сесію за темою, а remove видаляє тему в чаті", async () => {
		const { session } = setup({ BOT_TOKEN: "bot" });
		const methods: { method: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			methods.push({ method: String(url).split("/").pop()!, body: JSON.parse(init.body as string) });
			return Response.json({ ok: true, result: true });
		});
		await session.start(ID, { prompt: "Задача" });
		await session.watch(ID, { chatId: 42, url: "u", postId: 7, header: "h", threadId: 555 });
		expect(await session.byThread(42, 555)).toBe(ID);
		expect(await session.byThread(42, 556)).toBeUndefined();
		expect(await session.byThread(43, 555)).toBeUndefined();
		await session.remove(ID);
		expect(methods.filter((m) => m.method === "deleteForumTopic").map((m) => m.body)).toEqual([{ chat_id: 42, message_thread_id: 555 }]);
		expect(await session.byThread(42, 555)).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it("resetComputer: знімок викидається, контейнер зупиняється; з unlessBusy зайнятого не чіпає", async () => {
		const { session, container, opencode, store } = setup();
		await session.start(ID, { prompt: "Задача" }); // агент зайнятий
		expect(await session.resetComputer(true)).toBe(false);
		expect(container.running).toBe(true);
		store.set("snapshot", { id: "s", image: "image", at: 1 });
		expect(await session.resetComputer()).toBe(true);
		expect(container.running).toBe(false);
		expect(store.has("snapshot")).toBe(false);
		opencode.busy.clear();
		await session.followUp(ID, "Далі");
		expect(container.starts.at(-1)).toMatchObject({ image: "image" }); // знімка немає: старт із образу
	});

	it("remove: видаляє сесію OpenCode, теку й записи; невідома сесія — нічого", async () => {
		const { session, opencode, store } = setup();
		await session.remove("nope-0000");
		expect(opencode.deleted).toEqual([]);

		await session.start(ID, { prompt: "Задача", repo: "me/app" });
		await session.watch(ID, { chatId: 1, url: "u" });
		await session.remove(ID);
		expect(opencode.aborted).toEqual(["ses_oc1"]);
		expect(opencode.deleted).toEqual(["ses_oc1"]);
		const cleanup = opencode.execs.at(-1)!.cmd;
		expect(cleanup.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(cleanup.at(-1)).toBe(ID); // id іде аргументом, а не в тексті скрипта
		expect(cleanup[2]).toContain("publish --delete"); // сайти сесії видаляються разом з нею
		expect(cleanup[2]).toContain("worktree remove --force");
		// гілка видаляється лише якщо її кінчик уже на GitHub (origin/<гілка>) або збігається з головною: інакше робота лишається
		expect(cleanup[2]).toContain("branch -D");
		expect(cleanup[2]).toContain('"$tip" = "$pushed"');
		expect(cleanup[2]).toContain("agent/*");
		expect(await session.link(ID)).toBeUndefined();
		expect([...store.keys()].filter((k) => k.startsWith("watch:") || k.startsWith("session:"))).toEqual([]);
	});

	it("abort: перериває роботу, сесія лишається; на сплячому контейнері нічого не робить", async () => {
		const { session, container, opencode } = setup();
		await session.abort(ID);
		expect(opencode.aborted).toEqual([]);

		await session.start(ID, { prompt: "Задача" });
		await session.abort(ID);
		expect(opencode.aborted).toEqual(["ses_oc1"]);
		expect(await session.status(ID)).toBe("idle");

		container.sleep();
		const requests = opencode.requests.length;
		await session.abort(ID);
		expect(opencode.requests).toHaveLength(requests);
	});

	it("fetch: проксує веб-інтерфейс у контейнер з паролем і без cookie", async () => {
		const { session, opencode } = setup();
		const res = await session.fetch(new Request("https://agent.example/assets/app.js?v=1", { headers: { cookie: "agent_session=session-0001" } }));
		expect(await res.text()).toBe("ui /assets/app.js");
		expect(opencode.auths).toEqual(new Set([`Basic ${btoa("opencode:pw")}`]));
	});

	it("fetch: Origin прибирається (OpenCode перевіряє його збіг з Host контейнера для термінала)", async () => {
		const { session, opencode } = setup();
		await session.fetch(new Request("https://agent.example/api/experimental/persistent-pty/p1/connect-token", { method: "POST", headers: { origin: "https://agent.example", "x-opencode-ticket": "1" } }));
		expect(opencode.origins).toEqual([]);
		expect(opencode.tickets).toEqual(["1"]); // решта заголовків лишається
	});

	it("connections: рахує SSH-з'єднання з /proc/net/tcp, сплячий контейнер не будить", async () => {
		const { session, container, opencode } = setup();
		expect(await session.connections(true)).toEqual({ running: false });
		expect(opencode.execs).toEqual([]);
		container.running = true;
		opencode.procNet = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   ui",
			"   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000",
			"   1: 00000000:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000",
			"   2: 0100000A:1000 0000010A:849E 01 00000000:00000000 00:00000000 00000000",
			"   3: 0100000A:0016 0000010A:8CE4 01 00000000:00000000 00:00000000 00000000",
			"   4: 0100000A:0016 0000010A:8CE5 01 00000000:00000000 00:00000000 00000000",
			"   5: 0100000A:C102 420A1268:01BB 01 00000000:00000000 02:0000012C 00000000",
		].join("\n");
		expect(await session.connections(false)).toEqual({ running: true });
		expect(opencode.execs).toEqual([]); // без detail exec не викликається
		expect(await session.connections(true)).toEqual({ running: true, ssh: { listening: true, connections: 2 }, opencode: { listening: true, connections: 1 } });
	});

	it("у контейнер не потрапляють секрети чату, Access і чужих сервісів: лише дозволений набір", async () => {
		const { session, container } = setup({
			BOT_TOKEN: "bot",
			TG_WEBHOOK_SECRET: "w",
			TG_OWNER_ID: "1",
			CHAT_ID: "-100",
			ACCESS_AUD: "aud",
			ACCESS_TEAM_DOMAIN: "t",
			TODOIST_TOKEN: "todoist",
			CLAUDE_CODE_OAUTH_TOKEN: "claude",
			GITHUB_TOKEN: "gh",
			R2_ACCESS_KEY_ID: "k",
			R2_SECRET_ACCESS_KEY: "s",
			R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
			SITES_BASE_URL: "https://sites.example",
			PUBLIC_R2_ACCESS_KEY_ID: "pk",
			PUBLIC_R2_SECRET_ACCESS_KEY: "ps",
			PUBLIC_SITES_BASE_URL: "https://share.example",
		});
		await session.start(ID, { prompt: "Задача" });
		const env = container.starts[0].env as Record<string, string>;
		expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN", "OPENCODE_PASSWORD", "PUBLIC_R2_ACCESS_KEY_ID", "PUBLIC_R2_SECRET_ACCESS_KEY", "PUBLIC_SITES_BASE_URL", "R2_ACCESS_KEY_ID", "R2_ENDPOINT", "R2_SECRET_ACCESS_KEY", "SITES_BASE_URL"]);
	});

	it("MCP Sure: .opencode/opencode.json у теці лише для сесії зі sure і лише з налаштованим Sure; секрети в env, не у файлі", async () => {
		const base = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "w", TG_OWNER_ID: "1", CHAT_ID: "-100", ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "t" };
		const sureEnv = { ...base, SURE_MCP_URL: "https://sure.example/mcp", SURE_MCP_TOKEN: "tok", SURE_ACCESS_CLIENT_ID: "id.access", SURE_ACCESS_CLIENT_SECRET: "sec" };
		const shellWrites = (o: ReturnType<typeof setup>["opencode"]) => o.execs.filter((e) => e.cmd[0] === "sh");

		const plain = setup(sureEnv);
		await plain.session.start(ID, { prompt: "Задача" });
		expect(shellWrites(plain.opencode)).toEqual([]);

		const unset = setup(base);
		await unset.session.start(ID, { prompt: "Задача", sure: true });
		expect(shellWrites(unset.opencode)).toEqual([]);

		const { session, container, opencode } = setup(sureEnv);
		await session.start(ID, { prompt: "Задача", sure: true });
		const [exec] = shellWrites(opencode);
		const [file] = JSON.parse(exec.env!.PAYLOAD) as { path: string; content: string }[];
		expect(file.path).toBe(`/workspace/sessions/${ID}/.opencode/opencode.json`);
		const server = JSON.parse(file.content).mcp.servers.sure;
		expect(server).toMatchObject({ type: "remote", url: "https://sure.example/mcp", oauth: false });
		expect(server.headers).toEqual({ Authorization: "Bearer {env:SURE_MCP_TOKEN}", "CF-Access-Client-Id": "{env:SURE_ACCESS_CLIENT_ID}", "CF-Access-Client-Secret": "{env:SURE_ACCESS_CLIENT_SECRET}" });
		const config = JSON.parse(file.content);
		expect(config.default_agent).toBe("sure");
		expect(config.agents.sure).toMatchObject({ mode: "primary" });
		expect(config.agents.sure.system).toContain("publish ./site");
		expect(file.content).not.toMatch(/tok"|sec"|id\.access/);
		const env = container.starts[0].env as Record<string, string>;
		expect(env).toMatchObject({ SURE_MCP_TOKEN: "tok", SURE_ACCESS_CLIENT_ID: "id.access", SURE_ACCESS_CLIENT_SECRET: "sec" });
		expect(env.SURE_MCP_URL).toBeUndefined();
	});

	it("MCP Сільпо: токен у конфігу теки (права 600), окремий агент `silpo`, разом зі Sure — `finance`; без входу — примітка в завданні", async () => {
		const base = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "w", TG_OWNER_ID: "1", CHAT_ID: "-100", ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "t" };
		const sureEnv = { ...base, SURE_MCP_URL: "https://sure.example/mcp", SURE_MCP_TOKEN: "tok" };
		const login = { client: { id: "cid", redirect: "r" }, tokens: { access: "silpo-acc", refresh: "ref", expiresAt: Date.now() + 3_600_000 } };
		const written = (o: ReturnType<typeof setup>["opencode"]) => {
			const [exec] = o.execs.filter((e) => e.cmd[0] === "sh");
			const [file] = JSON.parse(exec.env!.PAYLOAD) as { path: string; mode: string; content: string }[];
			return { file, config: JSON.parse(file.content) };
		};

		const only = setup(base);
		only.store.set("silpo", login);
		await only.session.start(ID, { prompt: "Що я купував", silpo: true });
		const { file, config } = written(only.opencode);
		expect(file.mode).toBe("600");
		expect(config.default_agent).toBe("silpo");
		expect(config.mcp.servers).toEqual({ silpo: { type: "remote", url: "https://mcp.silpo.ua/mcp", oauth: false, headers: { Authorization: "Bearer silpo-acc" } } });
		expect(only.store.get(`session:${ID}`)).toMatchObject({ silpo: true });

		const both = setup(sureEnv);
		both.store.set("silpo", login);
		await both.session.start(ID, { prompt: "Зістав", silpo: true, sure: true });
		const b = written(both.opencode).config;
		expect(b.default_agent).toBe("finance");
		expect(Object.keys(b.mcp.servers).sort()).toEqual(["silpo", "sure"]);
		expect(b.agents.finance.system).toMatch(/Sure[\s\S]*Silpo/);

		const out = setup(base);
		await out.session.start(ID, { prompt: "Що я купував", silpo: true });
		expect(out.opencode.execs.filter((e) => e.cmd[0] === "sh")).toEqual([]);
		expect(JSON.stringify(out.opencode.prompts ?? out.opencode)).toContain("/silpo/login");
	});

	it("MCP Google Calendar: токен у конфігу теки (права 600), окремий агент `calendar`; разом зі Sure — `assistant`; без входу — примітка в завданні", async () => {
		const base = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "w", TG_OWNER_ID: "1", CHAT_ID: "-100", ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "t" };
		const login = { tokens: { access: "cal-acc", refresh: "ref", expiresAt: Date.now() + 3_600_000 } };
		const written = (o: ReturnType<typeof setup>["opencode"]) => {
			const [exec] = o.execs.filter((e) => e.cmd[0] === "sh");
			const files = JSON.parse(exec.env!.PAYLOAD) as { path: string; mode: string; content: string }[];
			return { files, config: JSON.parse(files[0].content) };
		};

		const only = setup(base);
		only.store.set("calendar", login);
		await only.session.start(ID, { prompt: "Що в мене сьогодні", calendar: true });
		const { files, config } = written(only.opencode);
		expect(config.default_agent).toBe("calendar");
		// Локальний MCP-сервер (nspady/google-calendar-mcp) читає токен із файлів теки сесії; токена в самому конфігу немає.
		expect(config.mcp.servers.calendar).toMatchObject({ type: "local", environment: { GOOGLE_CALENDAR_MCP_TOKEN_PATH: expect.stringContaining("/.opencode/calendar/tokens.json") } });
		expect(config.mcp.servers.calendar.environment.ENABLED_TOOLS).not.toContain("manage-accounts");
		expect(JSON.stringify(config)).not.toContain("cal-acc");
		const tokens = files.find((f) => f.path.endsWith("/calendar/tokens.json"))!;
		expect(tokens.mode).toBe("600");
		expect(JSON.parse(tokens.content)).toEqual({ normal: { access_token: "cal-acc", token_type: "Bearer", scope: "https://www.googleapis.com/auth/calendar", expiry_date: login.tokens.expiresAt } });
		const keys = files.find((f) => f.path.endsWith("/calendar/gcp-oauth.keys.json"))!;
		expect(keys.mode).toBe("600");
		expect(keys.content).not.toContain("refresh"); // справжнього client secret і refresh-токена в контейнері немає
		expect(only.store.get(`session:${ID}`)).toMatchObject({ calendar: true });

		const both = setup({ ...base, SURE_MCP_URL: "https://sure.example/mcp", SURE_MCP_TOKEN: "tok" });
		both.store.set("calendar", login);
		await both.session.start(ID, { prompt: "Зістав", calendar: true, sure: true });
		const b = written(both.opencode).config;
		expect(b.default_agent).toBe("assistant");
		expect(Object.keys(b.mcp.servers).sort()).toEqual(["calendar", "sure"]);

		const out = setup(base);
		await out.session.start(ID, { prompt: "Що в мене сьогодні", calendar: true });
		expect(out.opencode.execs.filter((e) => e.cmd[0] === "sh")).toEqual([]);
		expect(JSON.stringify(out.opencode.prompts ?? out.opencode)).toContain("/calendar/login");
	});

	describe("відстеження сесій: підсумок у чаті й ліміти", () => {
		const TARGET = { chatId: 5, url: "https://agent.example/s/session-0001" };
		const sent: { chat_id: number; text: string }[] = [];
		beforeEach(() => {
			sent.length = 0;
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
				sent.push(JSON.parse(init.body as string));
				return Response.json({ ok: true, result: { message_id: 1 } });
			});
		});
		afterEach(() => {
			vi.useRealTimers();
			vi.unstubAllGlobals();
			vi.stubGlobal("scheduler", { wait: async () => {} });
		});

		const watched = async (extraEnv: Record<string, string> = {}) => {
			const t = setup({ BOT_TOKEN: "bot", ...extraEnv });
			await t.session.start(ID, { prompt: "Задача" });
			await t.session.watch(ID, TARGET);
			return t;
		};
		const ocId = "ses_oc1";

		it("повідомлення з веб-інтерфейсу в сесію з постом у чаті вмикає стеження: підсумок приходить у пост", async () => {
			const t = setup({ BOT_TOKEN: "bot" });
			await t.session.start(ID, { prompt: "Задача" });
			await t.session.watch(ID, { ...TARGET, postId: 77, header: "🗣 Задача" });
			t.store.delete(`watch:${ID}`); // перше стеження завершилось
			sent.length = 0;
			await t.session.fetch(new Request(`https://agent.example/api/session/${ocId}/prompt`, { method: "POST", body: JSON.stringify({ text: "З інтерфейсу" }) }));
			expect(await t.store.get(`watch:${ID}`)).toMatchObject({ ocId, chatId: 5, postId: 77 });
			// Сесія без поста (запущена не з чату) не стежиться.
			await t.session.start("session-0002", { prompt: "Інша" });
			await t.session.fetch(new Request("https://agent.example/api/session/ses_oc2/prompt", { method: "POST", body: "{}" }));
			expect(await t.store.get("watch:session-0002")).toBeUndefined();
		});

		it("поки сесія працює, повідомлення немає, alarm частий; по завершенню приходить підсумок один раз", async () => {
			const { session, opencode, alarm } = await watched();
			opencode.lastText = "Зробив PR: https://github.com/me/app/pull/7";
			await session.alarm();
			expect(sent).toEqual([]);
			expect(alarm.at).toBeLessThanOrEqual(Date.now() + 15_000);

			opencode.busy.clear();
			opencode.info[ocId] = { outcome: "succeeded" };
			await session.alarm();
			expect(sent).toEqual([{ chat_id: 5, text: `✅ Готово\n\nЗробив PR: <a href="https://github.com/me/app/pull/7">me/app#7</a>\n\n🔗 <a href="${TARGET.url}">Відкрити сесію</a>`, parse_mode: "HTML", link_preview_options: { is_disabled: true } }]);
			await session.alarm();
			expect(sent).toHaveLength(1); // спостереження знято
		});

		describe("події OpenCode (SSE)", () => {
			const flush = async () => {
				for (let i = 0; i < 20; i++) await Promise.resolve();
				await new Promise((r) => setTimeout(r, 0));
			};
			const done = { type: "session.execution.succeeded", data: { sessionID: ocId } };

			it("підсумок приходить одразу по події завершення, без alarm; повторне опитування його не дублює", async () => {
				const { session, opencode } = await watched();
				expect(opencode.events).toHaveLength(1); // підписка відкрита
				opencode.busy.clear();
				opencode.info[ocId] = { outcome: "succeeded" };
				opencode.lastText = "Готово за подією";
				opencode.emit(done);
				await flush();
				expect(sent.filter((c) => String(c.text ?? "").includes("Готово за подією"))).toHaveLength(1);
				await session.alarm();
				expect(sent.filter((c) => String(c.text ?? "").includes("Готово за подією"))).toHaveLength(1);
			});

			it("швидка сесія: подія завершення працює, навіть коли опитування її ще не бачило працюючою", async () => {
				const { opencode } = await watched();
				opencode.busy.clear();
				opencode.lastText = "Миттєво";
				opencode.emit({ type: "session.execution.started", data: { sessionID: ocId } });
				opencode.emit(done);
				await flush();
				expect(sent.some((c) => String(c.text ?? "").includes("Миттєво"))).toBe(true);
			});

			it("чужі сесії й інші події ігноруються", async () => {
				const { opencode } = await watched();
				opencode.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_other" } });
				opencode.emit({ type: "session.step.started", data: { sessionID: ocId } });
				await flush();
				expect(sent.filter((c) => "text" in c && !("reaction" in c))).toEqual([]);
			});

			it("потік обірвався: наступне опитування відкриває його знову; без спостережень потік закривається", async () => {
				const { session, opencode } = await watched();
				opencode.events[0].close();
				await flush();
				await session.alarm();
				expect(opencode.events).toHaveLength(2);
			});

			it("зупинка за лімітом показує причину, а не «Зупинено» від події", async () => {
				const { session, opencode } = await watched({ AGENT_MAX_COST_USD: "1" });
				opencode.info[ocId] = { cost: 2 };
				await session.alarm();
				opencode.emit({ type: "session.execution.interrupted", data: { sessionID: ocId } });
				await flush();
				const texts = sent.map((c) => String(c.text ?? "")).filter(Boolean);
				expect(texts).toHaveLength(1);
				expect(texts[0]).toContain("вартість $2.00");
			});
		});

		it("👨‍💻 стоїть на пості, поки сесія працює, і знімається по завершенню (і коли її зупинили вручну)", async () => {
			const reactions = () => sent.filter((c) => "reaction" in c) as unknown as { message_id: number; reaction: unknown[] }[];
			for (const outcome of ["succeeded", "interrupted"]) {
				sent.length = 0;
				const t = setup({ BOT_TOKEN: "bot" });
				await t.session.start(ID, { prompt: "Задача" });
				await t.session.watch(ID, { ...TARGET, postId: 77 });
				expect(reactions()).toEqual([{ chat_id: 5, message_id: 77, reaction: [{ type: "emoji", emoji: "👨‍💻" }] }]);
				await t.session.alarm();
				t.opencode.busy.clear();
				t.opencode.info[ocId] = { outcome };
				await t.session.alarm();
				expect(reactions().at(-1)).toEqual({ chat_id: 5, message_id: 77, reaction: [] });
			}
		});

		it("уточнення на інший пост переносить 👨‍💻: на старому реакція знімається", async () => {
			const t = setup({ BOT_TOKEN: "bot" });
			await t.session.start(ID, { prompt: "Задача" });
			await t.session.watch(ID, { ...TARGET, postId: 10 });
			await t.session.watch(ID, { ...TARGET, postId: 11 });
			const reactions = sent.filter((c) => "reaction" in c).map((c) => [(c as unknown as { message_id: number }).message_id, (c as unknown as { reaction: unknown[] }).reaction.length]);
			expect(reactions).toEqual([[10, 1], [10, 0], [11, 1]]);
		});

		it("помилка сесії: у чат іде причина", async () => {
			const { session, opencode } = await watched();
			await session.alarm(); // бачимо, що працює
			opencode.busy.clear();
			opencode.info[ocId] = { outcome: "failed" };
			opencode.lastError = "Model unavailable";
			await session.alarm();
			expect(sent[0].text).toBe(`❌ Помилка: Model unavailable\n\n🔗 <a href="${TARGET.url}">Відкрити сесію</a>`);
		});

		it("403 від Cloudflare: зрозуміле повідомлення замість сирої помилки", async () => {
			const { session, opencode } = await watched();
			await session.alarm();
			opencode.busy.clear();
			opencode.info[ocId] = { outcome: "failed" };
			opencode.lastError = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";
			await session.alarm();
			expect(sent[0].text).toContain("Cloudflare тимчасово заблокував");
		});

		it("сесія, яку зупинили вручну, показує «Зупинено»", async () => {
			const { session, opencode } = await watched();
			await session.alarm();
			opencode.busy.clear();
			opencode.info[ocId] = { outcome: "interrupted" };
			await session.alarm();
			expect(sent[0].text).toContain("⏹ Зупинено");
		});

		describe("прийняті завдання (begin/resume) виконує alarm", () => {
			const HEADER = "🗣 Зроби візитку";
			const POST = { ...TARGET, postId: 77, header: HEADER };
			const texts = () => sent.map((c) => String(c.text ?? "")).filter(Boolean);

			it("begin лише приймає: контейнер не запускається, сесії немає, alarm негайно; повторна доставка не дублює", async () => {
				const { session, container, alarm, store } = setup({ BOT_TOKEN: "bot" });
				await session.begin(ID, { prompt: "Задача" }, POST);
				expect(container.running).toBe(false);
				expect(store.has(`session:${ID}`)).toBe(false);
				expect(alarm.at).toBeLessThanOrEqual(Date.now());
				expect(await session.link(ID)).toBe("pending"); // вебхук-повтор побачить, що завдання вже є
				await session.begin(ID, { prompt: "Інше" }, POST);
				expect([...store.keys()].filter((k) => k.startsWith("job:"))).toEqual([`job:${ID}`]);
			});

			it("alarm холодно запускає контейнер, створює сесію, стежить і змінює пост «Запускаю контейнер» → «Працює»", async () => {
				const { session, container, opencode, store } = setup({ BOT_TOKEN: "bot" });
				await session.begin(ID, { prompt: "Задача" }, POST);
				await session.alarm();
				expect(container.running).toBe(true);
				expect(opencode.prompts).toEqual([{ id: ocId, text: "Задача" }]);
				expect(store.has(`job:${ID}`)).toBe(false);
				expect(store.has(`watch:${ID}`)).toBe(true);
				const edits = sent.filter((c) => "message_id" in c).map((c) => String(c.text));
				expect(edits[0]).toContain("⏳ Запускаю контейнер");
				expect(edits.at(-1)).toContain("⏳ Працює");
			});

			it("збій запуску повторюється з наступним alarm; зрештою пост показує помилку, а не лишається «Запускаю»", async () => {
				const { session, opencode, alarm, store } = setup({ BOT_TOKEN: "bot" });
				vi.spyOn(console, "error").mockImplementation(() => {});
				await session.begin(ID, { prompt: "Задача" }, POST);
				opencode.execFails = true;
				await session.alarm();
				expect(store.has(`job:${ID}`)).toBe(true);
				expect(alarm.at).toBeGreaterThan(Date.now()); // повтор пізніше
				for (let i = 0; i < 6; i++) await session.alarm();
				expect(store.has(`job:${ID}`)).toBe(false);
				expect(texts().at(-1)).toContain("Не вдалося запустити агента");
				expect(store.has(`watch:${ID}`)).toBe(false);
			});

			it("тимчасовий збій: наступний alarm усе ж запускає сесію", async () => {
				const { session, opencode, store } = setup({ BOT_TOKEN: "bot" });
				vi.spyOn(console, "error").mockImplementation(() => {});
				await session.begin(ID, { prompt: "Задача" }, POST);
				opencode.execFails = true;
				await session.alarm();
				opencode.execFails = false;
				await session.alarm();
				expect(store.has(`job:${ID}`)).toBe(false);
				expect(store.has(`watch:${ID}`)).toBe(true);
			});

			it("resume: уточнення в сплячий контейнер іде через alarm, не блокуючи виклик", async () => {
				const { session, container, opencode } = setup({ BOT_TOKEN: "bot" });
				await session.start(ID, { prompt: "Задача" });
				await session.resume(ID, "Ще", { chatId: 5, url: TARGET.url });
				expect(opencode.prompts).toHaveLength(1); // дописане ще не надіслано
				container.running = false;
				await session.alarm();
				expect(opencode.prompts.map((p) => p.text)).toEqual(["Задача", "Ще"]);
			});

			it("remove скасовує завдання, яке ще не запустилось", async () => {
				const { session, store, container } = setup({ BOT_TOKEN: "bot" });
				await session.begin(ID, { prompt: "Задача" }, POST);
				await session.remove(ID);
				expect(store.has(`job:${ID}`)).toBe(false);
				await session.alarm();
				expect(container.running).toBe(false);
			});
		});

		describe("пост сесії оновлюється на місці", () => {
			const HEADER = "🗣 Зроби візитку\n\n📦 me/app";
			const POST = { ...TARGET, postId: 77, header: HEADER };
			const edits = () => sent.filter((c) => "message_id" in c && "text" in c) as unknown as { message_id: number; text: string }[];
			const link = `🔗 <a href="${TARGET.url}">Відкрити сесію</a>`;

			it("підсумок редагує пост (шапка + підсумок), а не шле нове повідомлення; шапка з підсумком скорочується", async () => {
				const t = setup({ BOT_TOKEN: "bot" });
				await t.session.start(ID, { prompt: "Задача" });
				await t.session.watch(ID, { ...POST, header: `🗣 ${"я".repeat(600)}` });
				t.opencode.lastText = "Готово: **ok**";
				await t.session.alarm();
				t.opencode.busy.clear();
				t.opencode.info[ocId] = { outcome: "succeeded" };
				await t.session.alarm();
				expect(sent.filter((c) => "chat_id" in c && "text" in c && !("message_id" in c))).toEqual([]); // нових повідомлень немає
				const [edit] = edits();
				expect(edit.message_id).toBe(77);
				expect(edit.text).toBe(`🗣 ${"я".repeat(397)}…\n\n✅ Готово\n\nГотово: <b>ok</b>\n\n${link}`);
			});

			it("деплой PR сесії дописується в її пост: запит на схвалення з кнопками, потім результат лише з «Видалити»", async () => {
				const t = setup({ BOT_TOKEN: "bot" });
				const SID = "tg-1-1";
				await t.session.start(SID, { prompt: "Задача", repo: "me/app", name: "card" });
				await t.session.watch(SID, { ...POST, url: "https://agent.example/s/tg-1-1" });
				t.opencode.busy.clear();
				t.opencode.info[ocId] = { outcome: "succeeded" };
				await t.session.alarm();
				const ids = () => ((edits().at(-1) as unknown as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard).map((r) => r.map((b) => b.callback_data));
				expect(await t.session.setDeploy("me/app", "card-1", { text: "🚀 Деплой чекає схвалення", repo: "me/app", runId: 9 })).toBe(true);
				expect(edits().at(-1)!.text).toContain("✅ Готово\n\n🚀 Деплой чекає схвалення");
				expect(ids()).toEqual([["appr:me/app:9", "rej:me/app:9"], ["del:tg-1-1"]]);
				expect(await t.session.setDeployByPost(77, { text: "✅ Деплой схвалено, виконується" })).toBe(true);
				expect(ids()).toEqual([["del:tg-1-1"]]);
				await t.session.setDeploy("me/app", "card-1", { text: "✅ Деплой успішний", done: true });
				expect(edits().at(-1)!.text).toContain("✅ Деплой успішний");
				expect(edits().at(-1)!.text).not.toContain("✅ Готово"); // підсумок агента згорнуто
				expect(ids()).toEqual([["dismiss"]]);
				expect(await t.session.setDeploy("me/app", "other-1", { text: "x" })).toBe(false);
			});

			describe("кнопка «Змерджити»", () => {
				const SID = "tg-1-1";
				const POST_TG = { ...POST, url: "https://agent.example/s/tg-1-1" };
				const buttons = () => ((edits().at(-1) as unknown as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard[0]).map((b) => b.callback_data);
				const finish = async (t: ReturnType<typeof setup>) => {
					await t.session.start(SID, { prompt: "Задача", repo: "me/app", name: "card" });
					await t.session.watch(SID, POST_TG);
					await t.session.alarm();
					t.opencode.busy.clear();
					t.opencode.info[ocId] = { outcome: "succeeded" };
					await t.session.alarm();
				};

				it("є відкритий PR гілки сесії → під підсумком «Змерджити»", async () => {
					const calls: string[] = [];
					const base = globalThis.fetch;
					vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
						if (!String(url).includes("api.github.com")) return base(url, init);
						calls.push(String(url));
						return Response.json([{ number: 7 }]);
					});
					await finish(setup({ BOT_TOKEN: "bot", GITHUB_TOKEN: "gh" }));
					expect(calls[0]).toContain("/repos/me/app/pulls?state=open&head=me%3Aagent%2Fcard-1");
					expect(buttons()).toEqual(["merge:tg-1-1", "del:tg-1-1"]);
				});

				it("без PR (чи без токена) лишається лише «Видалити»", async () => {
					const base = globalThis.fetch;
					vi.stubGlobal("fetch", async (url: string, init: RequestInit) => (String(url).includes("api.github.com") ? Response.json([]) : base(url, init)));
					await finish(setup({ BOT_TOKEN: "bot", GITHUB_TOKEN: "gh" }));
					expect(buttons()).toEqual(["del:tg-1-1"]);
				});
			});

			describe("прогрес у пості (події інструментів)", () => {
				const flush = async () => {
					for (let i = 0; i < 20; i++) await Promise.resolve();
					await new Promise((r) => setTimeout(r, 0));
				};
				const tool = (opencode: { emit(e: unknown): void }, id: string, name: string, input: Record<string, unknown>, session = ocId) => {
					opencode.emit({ type: "session.tool.input.started", data: { sessionID: session, id, name } });
					opencode.emit({ type: "session.tool.called", data: { sessionID: session, id, input } });
				};

				it("дія агента показується в пості; частіші за інтервал оновлення пропускаються", async () => {
					const t = setup({ BOT_TOKEN: "bot" });
					await t.session.start(ID, { prompt: "Задача" });
					await t.session.watch(ID, POST);
					tool(t.opencode, "c1", "edit", { filePath: "/workspace/sessions/docs-1/README.md" });
					await flush();
					tool(t.opencode, "c2", "read", { filePath: "/workspace/sessions/docs-1/a.ts" }); // надто швидко: пропущено
					await flush();
					expect(edits().map((e) => [e.message_id, e.text])).toEqual([[77, `${HEADER}\n\n⏳ Працює · редагує README.md\n\n${link}`]]);
					vi.setSystemTime(Date.now() + 5000);
					tool(t.opencode, "c3", "bash", { command: "npm test" });
					await flush();
					expect(edits().at(-1)!.text).toContain("⏳ Працює · виконує npm");
					expect(edits()).toHaveLength(2);
				});

				it("із ключем OpenAI дію описує маленька модель за завданням і останніми діями (а не «виконує grep»)", async () => {
					const bodies: { input: { content: string }[] }[] = [];
					vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
						if (!String(url).includes("api.openai.com")) {
							sent.push(JSON.parse(String(init.body)));
							return Response.json({ ok: true, result: { message_id: 1 } });
						}
						bodies.push(JSON.parse(String(init.body)));
						return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: "шукає, де формується підпис" }) }] }] });
					});
					const t = setup({ BOT_TOKEN: "bot", OPENAI_API_KEY: "k" });
					await t.session.start(ID, { prompt: "Задача" });
					await t.session.watch(ID, POST);
					tool(t.opencode, "c1", "grep", { pattern: "describeActivity" });
					await flush();
					expect(edits().at(-1)!.text).toBe(`${HEADER}\n\n⏳ Працює · шукає, де формується підпис\n\n${link}`);
					expect(bodies[0].input[1].content).toContain("- grep: describeActivity");
				});

				it("питання агента (form.created) показується одразу, навіть частіше за інтервал оновлень", async () => {
					const t = setup({ BOT_TOKEN: "bot" });
					await t.session.start(ID, { prompt: "Задача" });
					await t.session.watch(ID, POST);
					tool(t.opencode, "c1", "read", { filePath: "a" });
					await flush();
					t.opencode.emit({ type: "form.created", data: { form: { sessionID: ocId, title: "Який стиль?", fields: [{ title: "Стиль", options: [{ label: "Мінімалізм" }] }] } } });
					await flush();
					expect(edits()).toHaveLength(2); // дія й питання, без пропуску
					expect(edits().at(-1)!.text).toContain("❓ Який стиль?\nСтиль\n• Мінімалізм");
				});

				describe("відповідь кнопкою на питання агента", () => {
					const SID = "tg-1-1"; // id чату має префікс tg-: з нього береться callback_data
					const POST_TG = { ...POST, url: "https://agent.example/s/tg-1-1" };
					const form = (fields: unknown[]) => ({ type: "form.created", data: { form: { id: "form1", sessionID: ocId, title: "Який стиль?", fields } } });
					const style = { key: "style", type: "string", title: "Стиль", options: [{ value: "min", label: "Мінімалізм" }, { value: "bold", label: "Яскравий" }] };
					const keyboard = (c: unknown) => ((c as { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup?.inline_keyboard ?? []).map((row) => row.map((b) => `${b.text}=${b.callback_data}`));

					it("питання з варіантами: кнопки в пості, натискання відповідає на форму й показується в пості", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						t.opencode.emit(form([style]));
						await flush();
						const last = sent.filter((c) => "message_id" in c).at(-1)!;
						expect(keyboard(last)).toEqual([["Мінімалізм=ans:tg-1-1:0"], ["Яскравий=ans:tg-1-1:1"], ["⏹ Стоп=stop:tg-1-1", "🗑 Видалити=del:tg-1-1"]]);
						expect(await t.session.answer(SID, 1)).toBe("Відповідь: Яскравий");
						expect(t.opencode.formReplies).toEqual([{ path: `/api/session/${ocId}/form/form1/reply`, body: { answer: { style: "bold" } } }]);
						expect(edits().at(-1)!.text).toContain("відповідь: Яскравий");
						expect(await t.session.answer(SID, 1)).toBeUndefined(); // вже відповіли
					});

					it("текст замість кнопки скасовує питання й іде агентові", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						t.opencode.emit(form([style]));
						await flush();
						await t.session.followUp(SID, "Роби інакше");
						expect(t.opencode.formCancels).toEqual([`/api/session/${ocId}/form/form1?message=Роби інакше`]);
						expect(t.opencode.prompts.at(-1)!.text).toBe("Роби інакше");
						expect(await t.session.answer(SID, 1)).toBeUndefined(); // питання вже неактуальне
					});

					it("форма без кнопок (кілька питань): текстова відповідь теж скасовує її", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						t.opencode.emit(form([style, { key: "extra", type: "string" }]));
						await flush();
						await t.session.followUp(SID, "Ось відповідь");
						expect(t.opencode.formCancels).toEqual([`/api/session/${ocId}/form/form1?message=Ось відповідь`]);
					});

					it("так/ні дає булеві значення; одиночний multiselect — масив", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						t.opencode.emit(form([{ key: "ok", type: "boolean" }]));
						await flush();
						await t.session.answer(SID, 0);
						t.opencode.emit(form([{ key: "pick", type: "multiselect", maxItems: 1, options: [{ value: "a", label: "A" }] }]));
						await flush();
						await t.session.answer(SID, 0);
						expect(t.opencode.formReplies.map((r) => r.body)).toEqual([{ answer: { ok: true } }, { answer: { pick: ["a"] } }]);
					});

					it("складна форма (кілька полів) показується текстом без кнопок; відповісти кнопкою не можна", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						t.opencode.emit(form([style, { key: "extra", type: "string" }]));
						await flush();
						const last = sent.filter((c) => "message_id" in c).at(-1)!;
						expect(keyboard(last)).toEqual([["⏹ Стоп=stop:tg-1-1", "🗑 Видалити=del:tg-1-1"]]);
						expect(await t.session.answer(SID, 0)).toBeUndefined();
					});

					it("множинний вибір: кнопки перемикають варіанти з позначками, «Підтвердити» надсилає масив", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						const many = { key: "ideas", type: "multiselect", title: "Покращення", options: [{ value: "book", label: "Бронювання" }, { value: "cart", label: "Кошик" }, { value: "gallery", label: "Галерея" }] };
						t.opencode.emit(form([many]));
						await flush();
						const last = () => sent.filter((c) => "message_id" in c).at(-1)!;
						expect(keyboard(last())).toEqual([["Бронювання=tog:tg-1-1:0"], ["Кошик=tog:tg-1-1:1"], ["Галерея=tog:tg-1-1:2"], ["✅ Підтвердити=ok:tg-1-1"], ["⏹ Стоп=stop:tg-1-1", "🗑 Видалити=del:tg-1-1"]]);
						expect(await t.session.answer(SID, "ok")).toBe("Вибери хоча б один варіант."); // нічого не вибрано
						expect(await t.session.answer(SID, 2)).toBe("Вибрано: Галерея");
						expect(await t.session.answer(SID, 0)).toBe("Вибрано: Бронювання, Галерея");
						expect(keyboard(last())[0]).toEqual(["☑ Бронювання=tog:tg-1-1:0"]);
						expect(keyboard(last())[1]).toEqual(["☐ Кошик=tog:tg-1-1:1"]);
						expect(await t.session.answer(SID, 2)).toBe("Вибрано: Бронювання"); // повторне натискання знімає вибір
						expect(t.opencode.formReplies).toEqual([]); // поки не підтверджено, агентові нічого не йде
						await t.session.answer(SID, 1);
						expect(await t.session.answer(SID, "ok")).toBe("Відповідь: Бронювання, Кошик");
						expect(t.opencode.formReplies).toEqual([{ path: `/api/session/${ocId}/form/form1/reply`, body: { answer: { ideas: ["book", "cart"] } } }]);
						expect(edits().at(-1)!.text).toContain("відповідь: Бронювання, Кошик");
						expect(await t.session.answer(SID, "ok")).toBeUndefined(); // питання закрите
					});

					it("після завершення сесії питання неактуальне", async () => {
						const t = setup({ BOT_TOKEN: "bot" });
						await t.session.start(SID, { prompt: "Задача" });
						await t.session.watch(SID, POST_TG);
						t.opencode.emit(form([style]));
						await flush();
						t.opencode.busy.clear();
						t.opencode.info[ocId] = { outcome: "succeeded" };
						t.opencode.emit({ type: "session.execution.succeeded", data: { sessionID: ocId } });
						await flush();
						expect(await t.session.answer(SID, 0)).toBeUndefined();
					});
				});

				it("чужа сесія, виклик без відомої назви і сесія без поста нічого не редагують", async () => {
					const t = setup({ BOT_TOKEN: "bot" });
					await t.session.start(ID, { prompt: "Задача" });
					await t.session.watch(ID, POST);
					tool(t.opencode, "c1", "edit", { filePath: "a" }, "ses_other");
					t.opencode.emit({ type: "session.tool.called", data: { sessionID: ocId, id: "unknown", input: {} } });
					await flush();
					expect(edits()).toEqual([]);
				});

				it("після підсумку проміжні події пост не чіпають", async () => {
					const t = setup({ BOT_TOKEN: "bot" });
					await t.session.start(ID, { prompt: "Задача" });
					await t.session.watch(ID, POST);
					t.opencode.busy.clear();
					t.opencode.info[ocId] = { outcome: "succeeded" };
					t.opencode.lastText = "Готово";
					t.opencode.emit({ type: "session.execution.succeeded", data: { sessionID: ocId } });
					await flush();
					vi.setSystemTime(Date.now() + 5000);
					tool(t.opencode, "late", "edit", { filePath: "a" });
					await flush();
					expect(edits()).toHaveLength(1);
					expect(edits()[0].text).toContain("✅ Готово");
				});
			});

			it("уточнення: пост знову показує «Працює» (пост береться зі сховища), потім підсумок", async () => {
				const t = setup({ BOT_TOKEN: "bot" });
				await t.session.start(ID, { prompt: "Задача" });
				await t.session.watch(ID, POST); // перше спостереження: пост уже показує «Працює», редагувати не треба
				expect(edits()).toEqual([]);
				await t.session.watch(ID, { chatId: 5, url: TARGET.url }); // уточнення
				expect(edits().map((e) => [e.message_id, e.text])).toEqual([[77, `${HEADER}\n\n⏳ Працює\n\n${link}`]]);
			});

			it("пост видалили чи редагування не вдалось: підсумок іде новим повідомленням", async () => {
				const t = setup({ BOT_TOKEN: "bot" });
				await t.session.start(ID, { prompt: "Задача" });
				await t.session.watch(ID, POST);
				vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
					const body = JSON.parse(init.body as string);
					sent.push(body);
					return url.endsWith("/editMessageText") ? new Response("message to edit not found", { status: 400 }) : Response.json({ ok: true, result: { message_id: 2 } });
				});
				await t.session.alarm();
				t.opencode.busy.clear();
				t.opencode.info[ocId] = { outcome: "succeeded" };
				t.opencode.lastText = "Готово";
				await t.session.alarm();
				expect(sent.filter((c) => !("message_id" in c) && "text" in c && String(c.text).includes("✅ Готово"))).toHaveLength(1);
			});
		});

		it("швидка сесія, якої ми не встигли побачити працюючою, теж отримує підсумок, але не одразу", async () => {
			const { session, opencode } = await watched();
			opencode.busy.clear();
			opencode.info[ocId] = { outcome: "succeeded" };
			opencode.lastText = "Готово швидко";
			await session.alarm();
			expect(sent).toEqual([]); // ще можливо, що вона не стартувала
			vi.setSystemTime(Date.now() + 30_000);
			await session.alarm();
			expect(sent[0].text).toContain("Готово швидко");
		});

		it("перевищення вартості зупиняє сесію й повідомляє", async () => {
			const { session, opencode } = await watched({ AGENT_MAX_COST_USD: "1" });
			opencode.info[ocId] = { cost: 1.5 };
			await session.alarm();
			expect(opencode.aborted).toEqual([ocId]);
			expect(sent[0].text).toContain("вартість $1.50 (ліміт $1)");
			await session.alarm();
			expect(sent).toHaveLength(1);
		});

		it("перевищення токенів зупиняє і сесію без спостереження (запущену з веб-інтерфейсу), без повідомлення", async () => {
			const { session, opencode } = setup({ BOT_TOKEN: "bot", AGENT_MAX_TOKENS: "1000" });
			await session.start(ID, { prompt: "Задача" }); // без watch
			opencode.info[ocId] = { tokens: { input: 600, output: 500 } };
			await session.alarm();
			expect(opencode.aborted).toEqual([ocId]);
			expect(sent).toEqual([]);
		});

		it("контейнер зупинився, не дочекавшись завершення: повідомлення й кінець спостереження", async () => {
			const { session, container } = await watched();
			container.running = false;
			await session.alarm();
			expect(sent[0].text).toContain("Контейнер зупинився");
			await session.alarm();
			expect(sent).toHaveLength(1);
		});

		it("report: статус, результат і вартість; сплячий контейнер не будить", async () => {
			const { session, container, opencode } = setup();
			await session.start(ID, { prompt: "Задача" });
			expect(await session.report(ID)).toEqual({ status: "working" });
			opencode.busy.clear();
			opencode.info[ocId] = { outcome: "succeeded", cost: 0.42, tokens: { input: 100, output: 20 } };
			expect(await session.report(ID)).toEqual({ status: "idle", outcome: "succeeded", cost: 0.42, tokens: 120 });
			container.running = false;
			expect(await session.report(ID)).toEqual({ status: "stopped" });
			expect(await session.report("nope-0000")).toEqual({ status: "stopped" });
		});
	});

	describe("знімки диска", () => {
		// Агент відпрацював: активність була, зараз вільний.
		async function finishedTask(extraEnv: Record<string, string> = {}) {
			const t = setup(extraEnv);
			await t.session.start(ID, { prompt: "Задача" });
			t.opencode.busy.clear();
			return t;
		}

		it("alarm планується після активності, але не після знімка (інакше контейнер не засне)", async () => {
			const { session, alarm } = await finishedTask();
			expect(alarm.at).not.toBeNull();
			alarm.at = null;
			await session.alarm();
			expect(alarm.at).toBeNull();
		});

		it("alarm знімає диск, коли агент вільний, і зберігає handle разом з образом", async () => {
			const { session, container, store } = await finishedTask();
			await session.alarm();
			expect(container.snapshots.size).toBe(1);
			expect(store.get("snapshot")).toMatchObject({ id: "snap1", image: "image" });
		});

		it("alarm нічого не знімає, поки агент працює, і чекає наступного разу", async () => {
			const { session, container, opencode, alarm } = setup();
			await session.start(ID, { prompt: "Задача" });
			expect(opencode.busy.size).toBe(1);
			alarm.at = null;
			await session.alarm();
			expect(container.snapshots.size).toBe(0);
			expect(alarm.at).not.toBeNull();
		});

		it("alarm не знімає вдруге, якщо змін після знімка не було, і не чіпає сплячий контейнер", async () => {
			const { session, container } = await finishedTask();
			await session.alarm();
			await session.alarm();
			expect(container.snapshots.size).toBe(1);
			container.sleep();
			await session.alarm();
			expect(container.snapshots.size).toBe(1);
		});

		it("після сну followUp відновлює контейнер зі знімка: та сама сесія OpenCode, без повторного підключення Claude Agent", async () => {
			const { session, container, opencode } = await finishedTask({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
			await session.alarm();
			container.sleep();
			await session.followUp(ID, "Продовжуй");
			expect(container.starts).toHaveLength(2);
			expect(container.starts[1]).toMatchObject({ containerSnapshot: { id: "snap1" } });
			expect(container.starts[1]).not.toHaveProperty("image");
			expect(opencode.seq).toBe(1); // нової сесії OpenCode не створено
			expect(opencode.prompts.at(-1)).toEqual({ id: "ses_oc1", text: "Продовжуй" });
			expect(opencode.requests.filter((r) => r.includes("connect/external"))).toHaveLength(1);
		});

		it("alarm не знімає, поки зайнята хоч одна з сесій", async () => {
			const { session, container, opencode, alarm } = setup();
			await session.start("session-0001", { prompt: "А" });
			await session.start("session-0002", { prompt: "Б" });
			opencode.busy.delete("ses_oc1"); // перша вільна, друга ще працює
			alarm.at = null;
			await session.alarm();
			expect(container.snapshots.size).toBe(0);
			expect(alarm.at).not.toBeNull();
		});

		it("snapshot(): примусово зберігає диск, навіть без активності через воркер (SSH)", async () => {
			const { session, container, store } = await finishedTask();
			await session.alarm();
			expect(container.snapshots.size).toBe(1);
			const info = await session.snapshot(); // alarm вдруге нічого б не зробив
			expect(info).toMatchObject({ id: "snap2", bytes: 1 });
			expect(container.snapshots.size).toBe(2);
			expect(store.get("snapshot")).toMatchObject({ id: "snap2" });
		});

		it("snapshot(): помилка, поки агент працює або контейнер спить (і не будить його)", async () => {
			const { session, container } = setup();
			await session.start(ID, { prompt: "Задача" }); // агент зайнятий
			await expect(session.snapshot()).rejects.toThrow(/busy/);
			container.sleep();
			const starts = container.starts.length;
			await expect(session.snapshot()).rejects.toThrow(/not running/);
			expect(container.starts).toHaveLength(starts);
		});

		it("знімок від іншого образу теж відновлюється (історія не губиться); новий образ лише через resetComputer", async () => {
			const { session, container, opencode } = await finishedTask();
			await session.alarm();
			container.sleep();
			container.images.base = "image2"; // деплой із новим образом
			await session.followUp(ID, "Продовжуй");
			expect(container.starts[1]).toHaveProperty("containerSnapshot");
			expect(container.starts[1]).not.toHaveProperty("image");
			expect(opencode.seq).toBe(1); // сесія та сама, історія на місці
			await session.resetComputer();
			await session.followUp(ID, "Ще");
			expect(container.starts[2]).toMatchObject({ image: "image2" }); // новий образ лише після /update
		});

		it("працюючий контейнер зі старого образу не перезапускається сам після деплою", async () => {
			const { session, container } = await finishedTask();
			container.images.base = "image2";
			await session.followUp(ID, "Продовжуй");
			expect(container.starts).toHaveLength(1);
		});

		it("якщо знімок не відновився, видаляє його й стартує з чистого образу", async () => {
			const { session, container, store } = await finishedTask();
			await session.alarm();
			container.sleep();
			container.failRestore = true;
			await session.followUp(ID, "Продовжуй");
			expect(container.starts).toHaveLength(3); // знімок → збій → образ
			expect(container.starts[2]).toMatchObject({ image: "image" });
			expect(store.has("snapshot")).toBe(false);
		});
	});
});

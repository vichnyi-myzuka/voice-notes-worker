import { beforeEach, describe, expect, it, vi } from "vitest";

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
	const opencode = { sessions: new Set<string>(), prompts: [] as { id: string; text: string }[], busy: new Set<string>(), aborted: [] as string[], seq: 0, requests: [] as string[], auths: new Set<string>(), directories: [] as string[], execs: [] as { cmd: string[]; env?: Record<string, string> }[], execFails: false, origins: [] as string[], tickets: [] as string[], execActive: 0, execMax: 0, models: [] as unknown[], connected: false, modelChecks: 0, modelsAfter: 0 };
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
			opencode.execs.push({ cmd, env: options?.env });
			opencode.execMax = Math.max(opencode.execMax, ++opencode.execActive);
			await Promise.resolve();
			opencode.execActive--;
			return {
				output: async () => ({
					exitCode: opencode.execFails ? 1 : 0,
					stdout: new TextEncoder().encode(`/workspace/sessions/${cmd[1]}\n`),
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
				if (path === "/api/model") return ok(opencode.connected && ++opencode.modelChecks > opencode.modelsAfter ? [{ id: "sonnet", providerID: "claude-agent" }, { id: "opus", providerID: "claude-agent" }] : []);
				if (path === "/api/session/active") return ok(Object.fromEntries([...opencode.busy].map((id) => [id, { type: "running" }])));
				const m = path.match(/^\/api\/session\/([^/]+)(?:\/(prompt|interrupt))?$/);
				if (m && !opencode.sessions.has(m[1])) return new Response("not found", { status: 404 });
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
				if (m) return ok({ id: m[1] });
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

	it("fetch: Origin підміняється на адресу контейнера (OpenCode перевіряє збіг з Host для термінала)", async () => {
		const { session, opencode } = setup();
		await session.fetch(new Request("https://agent.example/api/experimental/persistent-pty/p1/connect-token", { method: "POST", headers: { origin: "https://agent.example", "x-opencode-ticket": "1" } }));
		expect(opencode.origins).toEqual(["http://container"]);
		expect(opencode.tickets).toEqual(["1"]); // решта заголовків лишається
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

		it("знімок від іншого образу не відновлюється: старт з чистого образу", async () => {
			const { session, container, opencode } = await finishedTask();
			await session.alarm();
			container.sleep();
			container.images.base = "image2";
			await session.followUp(ID, "Продовжуй");
			expect(container.starts[1]).toMatchObject({ image: "image2" });
			expect(container.starts[1]).not.toHaveProperty("containerSnapshot");
			expect(opencode.seq).toBe(2); // стару історію втрачено, сесія нова
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

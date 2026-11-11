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
	const opencode = { sessions: new Set<string>(), prompts: [] as { id: string; text: string }[], busy: new Set<string>(), aborted: [] as string[], seq: 0, requests: [] as string[], auths: new Set<string>(), directories: [] as string[], models: [] as unknown[] };
	const container = {
		running: false,
		images: { base: "image" },
		starts: [] as Record<string, unknown>[],
		start(options: Record<string, unknown>) {
			container.running = true;
			container.starts.push(options);
		},
		monitor: () => new Promise<void>(() => {}),
		setInactivityTimeout: async () => {},
		// Контейнер заснув: процес зник разом із диском.
		sleep() {
			container.running = false;
			opencode.sessions.clear();
			opencode.busy.clear();
		},
		getTcpPort: () => ({
			fetch: async (input: string | Request, init?: RequestInit) => {
				const req = new Request(input, init);
				const path = new URL(req.url).pathname;
				opencode.requests.push(`${req.method} ${path}`);
				opencode.auths.add(req.headers.get("authorization") ?? "");
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
				if (req.method === "POST" && path === "/api/integration/claude-agent/connect/external") return new Response(null, { status: 204 });
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
	const ctx = {
		container,
		storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v) },
		blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
		waitUntil: () => {},
	};
	const env = { OPENCODE_PASSWORD: "pw", ANTHROPIC_API_KEY: "ak", GITHUB_TOKEN: undefined, ...extraEnv };
	const session = new AgentSession(ctx as unknown as DurableObjectState, env as never);
	return { session, container, opencode, store };
}

beforeEach(() => vi.stubGlobal("scheduler", { wait: async () => {} }));

describe("AgentSession", () => {
	it("start: піднімає контейнер, створює сесію OpenCode й ставить задачу", async () => {
		const { session, container, opencode } = setup();
		const { sessionId } = await session.start({ prompt: "Поправ README", repo: "me/app" });
		expect(sessionId).toBe("ses_oc1");
		expect(container.starts).toHaveLength(1);
		expect(container.starts[0]).toMatchObject({ enableInternet: true, env: { OPENCODE_PASSWORD: "pw", ANTHROPIC_API_KEY: "ak", REPO: "me/app" } });
		// Порожні секрети в контейнер не передаються.
		expect(container.starts[0].env).not.toHaveProperty("GITHUB_TOKEN");
		expect(opencode.prompts).toEqual([{ id: "ses_oc1", text: "Поправ README" }]);
		expect(opencode.directories).toEqual(["/workspace/repo"]); // клон репозиторію
		expect(opencode.auths).toEqual(new Set([`Basic ${btoa("opencode:pw")}`]));
	});

	it("з токеном підписки: токен іде в контейнер, Claude Agent підключається один раз за старт, сесії — з його моделлю", async () => {
		const { session, container, opencode } = setup({ CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_MODEL: "opus" });
		await session.start({ prompt: "Задача" });
		expect(container.starts[0].env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
		expect(opencode.requests.filter((r) => r.includes("connect/external"))).toHaveLength(1);
		expect(opencode.models).toEqual([{ providerID: "claude-agent", id: "opus" }]);
		container.sleep();
		await session.followUp("Ще раз"); // новий старт контейнера → підключення знову
		expect(opencode.requests.filter((r) => r.includes("connect/external"))).toHaveLength(2);
	});

	it("без токена підписки модель не задається й Claude Agent не підключається", async () => {
		const { session, opencode } = setup();
		await session.start({ prompt: "Задача" });
		expect(opencode.models).toEqual([undefined]);
		expect(opencode.requests.some((r) => r.includes("connect/external"))).toBe(false);
	});

	it("start без репозиторію працює в порожній /workspace", async () => {
		const { session, opencode } = setup();
		await session.start({ prompt: "Задача" });
		expect(opencode.directories).toEqual(["/workspace"]);
	});

	it("start ідемпотентний: повтор не створює другу сесію й не ставить задачу вдруге", async () => {
		const { session, container, opencode } = setup();
		await session.start({ prompt: "Задача" });
		const again = await session.start({ prompt: "Задача" });
		expect(again.sessionId).toBe("ses_oc1");
		expect(container.starts).toHaveLength(1);
		expect(opencode.seq).toBe(1);
		expect(opencode.prompts).toHaveLength(1);
	});

	it("status: working, поки агент зайнятий; idle після завершення; stopped, коли контейнер спить (і не будить його)", async () => {
		const { session, container, opencode } = setup();
		expect(await session.status()).toBe("stopped");
		await session.start({ prompt: "Задача" });
		expect(await session.status()).toBe("working");
		opencode.busy.clear();
		expect(await session.status()).toBe("idle");

		container.sleep();
		const startsBefore = container.starts.length;
		expect(await session.status()).toBe("stopped");
		expect(container.starts).toHaveLength(startsBefore);
	});

	it("followUp: дописує в ту саму сесію OpenCode", async () => {
		const { session, opencode } = setup();
		await session.start({ prompt: "Перша" });
		await session.followUp("Уточнення");
		expect(opencode.prompts).toEqual([
			{ id: "ses_oc1", text: "Перша" },
			{ id: "ses_oc1", text: "Уточнення" },
		]);
	});

	it("followUp після сну контейнера: старої сесії вже немає, тож створюється нова й контейнер стартує знову", async () => {
		const { session, container, opencode } = setup();
		await session.start({ prompt: "Перша", repo: "me/app" });
		container.sleep();
		await session.followUp("Продовжуй");
		expect(container.starts).toHaveLength(2);
		expect(container.starts[1]).toMatchObject({ env: { REPO: "me/app" } });
		expect(opencode.prompts.at(-1)).toEqual({ id: "ses_oc2", text: "Продовжуй" });
		expect(await session.status()).toBe("working");
	});

	it("abort: перериває роботу, сесія лишається; на сплячому контейнері нічого не робить", async () => {
		const { session, container, opencode } = setup();
		await session.abort();
		expect(opencode.aborted).toEqual([]);

		await session.start({ prompt: "Задача" });
		await session.abort();
		expect(opencode.aborted).toEqual(["ses_oc1"]);
		expect(await session.status()).toBe("idle");

		container.sleep();
		const requests = opencode.requests.length;
		await session.abort();
		expect(opencode.requests).toHaveLength(requests);
	});

	it("fetch: проксує веб-інтерфейс у контейнер з паролем і без cookie", async () => {
		const { session, opencode } = setup();
		const res = await session.fetch(new Request("https://agent.example/assets/app.js?v=1", { headers: { cookie: "agent_session=session-0001" } }));
		expect(await res.text()).toBe("ui /assets/app.js");
		expect(opencode.auths).toEqual(new Set([`Basic ${btoa("opencode:pw")}`]));
	});
});

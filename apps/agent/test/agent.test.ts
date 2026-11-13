import { describe, expect, it, vi } from "vitest";
import { durableAgent, type SessionObject } from "../src/infrastructure/container/agent";

describe("durableAgent", () => {
	function setup() {
		const stub: SessionObject = {
			start: vi.fn(async () => ({ sessionId: "oc1" })),
			begin: vi.fn(async () => {}),
			resume: vi.fn(async () => {}),
			answer: vi.fn(async () => "Мінімалізм"),
			followUp: vi.fn(async () => {}),
			setModel: vi.fn(async () => true),
			status: vi.fn(async () => "working" as const),
			abort: vi.fn(async () => {}),
			link: vi.fn(async () => "ses_oc1"),
			byThread: vi.fn(async () => undefined),
			pullTarget: vi.fn(async () => undefined),
			setDeploy: vi.fn(async () => false),
			setDeployByPost: vi.fn(async () => false),
			saveRef: vi.fn(async () => {}),
			takeRef: vi.fn(async () => undefined),
			snapshot: vi.fn(async () => ({ id: "snap1", bytes: 1, ms: 2 })),
			resetComputer: vi.fn(async () => true),
			remove: vi.fn(async () => {}),
			removeByBranch: vi.fn(async () => undefined),
			report: vi.fn(async () => ({ status: "idle" as const })),
			watch: vi.fn(async () => {}),
			connections: vi.fn(async () => ({ running: false })),
			silpoLoginUrl: vi.fn(async () => "https://mcp.silpo.ua/authorize"),
			silpoCallback: vi.fn(async () => true),
			silpoConnected: vi.fn(async () => true),
			calendarLoginUrl: vi.fn(async () => "https://accounts.google.com/o/oauth2/v2/auth"),
			calendarCallback: vi.fn(async () => true),
			calendarConnected: vi.fn(async () => true),
			info: vi.fn(async () => ({ running: true, activeAt: null, alarmAt: null, snapshot: null, streams: [] })),
			fetch: vi.fn(async () => new Response("ui")),
		};
		const names: string[] = [];
		const agent = durableAgent({ getByName: (name) => (names.push(name), stub) }, "https://agent.example");
		return { agent, stub, names };
	}

	it("start віддає посилання на сесію; усі сесії живуть в одному Durable Object `main`", async () => {
		const { agent, stub, names } = setup();
		expect(await agent.start("session-0001", { prompt: "Задача", repo: "me/app" })).toEqual({ id: "session-0001", url: "https://agent.example/s/session-0001" });
		expect(stub.start).toHaveBeenCalledWith("session-0001", { prompt: "Задача", repo: "me/app" });
		await agent.start("session-0002", { prompt: "Інша" });
		expect(names).toEqual(["main", "main"]);
	});

	it("url не звертається до Durable Object; begin і resume делегуються з ціллю стеження", async () => {
		const { agent, stub, names } = setup();
		expect(agent.url("session-0003")).toBe("https://agent.example/s/session-0003");
		const target = { chatId: 5, url: agent.url("session-0003"), postId: 9, header: "h" };
		await agent.begin("session-0003", { prompt: "Задача" }, target);
		await agent.resume("session-0003", "Ще", target);
		expect(await agent.answer("session-0003", 1)).toBe("Мінімалізм");
		expect(stub.answer).toHaveBeenCalledWith("session-0003", 1);
		expect(stub.begin).toHaveBeenCalledWith("session-0003", { prompt: "Задача" }, target);
		expect(stub.resume).toHaveBeenCalledWith("session-0003", "Ще", target);
		expect(names).toEqual(["main", "main", "main"]);
	});

	it("решта операцій делегується з id сесії; веб-інтерфейс і знімок не залежать від id", async () => {
		const { agent, stub, names } = setup();
		await agent.followUp("session-0002", "Уточнення");
		expect(await agent.status("session-0002")).toBe("working");
		await agent.abort("session-0002");
		expect(await agent.link("session-0002")).toBe("ses_oc1");
		expect(await agent.snapshot()).toEqual({ id: "snap1", bytes: 1, ms: 2 });
		const req = new Request("https://agent.example/");
		expect(await (await agent.serve(req)).text()).toBe("ui");
		expect(stub.followUp).toHaveBeenCalledWith("session-0002", "Уточнення");
		expect(stub.abort).toHaveBeenCalledWith("session-0002");
		expect(stub.fetch).toHaveBeenCalledWith(req);
		expect(new Set(names)).toEqual(new Set(["main"]));
	});
});

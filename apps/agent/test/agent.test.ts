import { describe, expect, it, vi } from "vitest";
import { durableAgent, type SessionObject } from "../src/infrastructure/container/agent";

describe("durableAgent", () => {
	function setup() {
		const stub: SessionObject = {
			start: vi.fn(async () => ({ sessionId: "oc1" })),
			followUp: vi.fn(async () => {}),
			status: vi.fn(async () => "working" as const),
			abort: vi.fn(async () => {}),
			fetch: vi.fn(async () => new Response("ui")),
		};
		const names: string[] = [];
		const agent = durableAgent({ getByName: (name) => (names.push(name), stub) }, "https://agent.example");
		return { agent, stub, names };
	}

	it("start віддає посилання на сесію з іменем Durable Object = id", async () => {
		const { agent, stub, names } = setup();
		expect(await agent.start("session-0001", { prompt: "Задача", repo: "me/app" })).toEqual({ id: "session-0001", url: "https://agent.example/s/session-0001" });
		expect(stub.start).toHaveBeenCalledWith({ prompt: "Задача", repo: "me/app" });
		expect(names).toEqual(["session-0001"]);
	});

	it("решта операцій делегується сесії з тим самим id", async () => {
		const { agent, stub, names } = setup();
		await agent.followUp("session-0002", "Уточнення");
		expect(await agent.status("session-0002")).toBe("working");
		await agent.abort("session-0002");
		const req = new Request("https://agent.example/");
		expect(await (await agent.serve("session-0002", req)).text()).toBe("ui");
		expect(stub.followUp).toHaveBeenCalledWith("Уточнення");
		expect(stub.abort).toHaveBeenCalled();
		expect(stub.fetch).toHaveBeenCalledWith(req);
		expect(new Set(names)).toEqual(new Set(["session-0002"]));
	});
});

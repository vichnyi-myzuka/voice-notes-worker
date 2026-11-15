import { describe, expect, it } from "vitest";
import { Mcp, requestedMcp } from "../src/application/mcp";
import { fakeMcpAccess, fakeNotices, fakeStore } from "./fake-ports";

describe("requestedMcp", () => {
	it("бачить `request-mcp <сервіс>` у команді bash (також у ланцюжку), а іншу команду чи невідомий сервіс — ні", () => {
		expect(requestedMcp({ command: "request-mcp cloudflare" })).toBe("cloudflare");
		expect(requestedMcp({ command: "cd /tmp && request-mcp sure; echo ok" })).toBe("sure");
		expect(requestedMcp({ command: "request-mcp calendar" })).toBe("calendar");
		expect(requestedMcp({ command: "request-mcp bank" })).toBeUndefined();
		expect(requestedMcp({ command: "request-mcp cloudflare-x" })).toBeUndefined();
		expect(requestedMcp({ command: "echo request-mcp-notes cloudflare" })).toBeUndefined();
		expect(requestedMcp({ command: "npm test" })).toBeUndefined();
		expect(requestedMcp({})).toBeUndefined();
		expect(requestedMcp(undefined)).toBeUndefined();
	});
});

describe("Mcp (запит агента і відповідь власника)", () => {
	async function setup(access = fakeMcpAccess(), enabled = true) {
		const store = fakeStore();
		const n = fakeNotices(enabled);
		const told: string[] = [];
		await store.saveSession("s1", { ocId: "oc1", post: { postId: 1, header: "", chatId: 5, threadId: 8, url: "u" } });
		return { store, n, told, access, mcp: new Mcp(store, access.access, n.notices, async (_id, _t, text) => void told.push(text)) };
	}

	it("запит агента надсилає кнопки в тему сесії один раз, поки власник не відповів", async () => {
		const { mcp, n } = await setup();
		await mcp.request("oc1", "silpo");
		await mcp.request("oc1", "silpo");
		expect(n.mcpQuestions).toEqual([{ id: "s1", name: "silpo", threadId: 8 }]);
	});

	it("не питає, якщо сервіс уже підключено, сесії чи бота немає", async () => {
		const a = await setup();
		await a.store.saveSession("s1", { ocId: "oc1", silpo: true, post: { postId: 1, header: "", chatId: 5, url: "u" } });
		await a.mcp.request("oc1", "silpo");
		await a.mcp.request("nope", "sure");
		expect(a.n.mcpQuestions).toEqual([]);
		const b = await setup(undefined, false);
		await b.mcp.request("oc1", "sure");
		expect(b.n.mcpQuestions).toEqual([]);
	});

	it("відмова, ненастроєний сервіс і відсутній вхід повідомляють агента й нічого не підключають", async () => {
		const { mcp, told, access } = await setup(fakeMcpAccess({ unconfigured: ["sure"], loggedOut: ["calendar"] }));
		expect(await mcp.answer("s1", "silpo", false)).toBe("declined");
		expect(await mcp.answer("s1", "sure", true)).toBe("unavailable");
		expect(await mcp.answer("s1", "calendar", true)).toBe("login");
		expect(told).toHaveLength(3);
		expect(told[2]).toContain("/calendar/login");
		expect(access.connected).toEqual([]);
	});

	it("згода підключає сервіс, зберігає прапорець і дає агентові інструкцію", async () => {
		const { mcp, store, told, access } = await setup();
		expect(await mcp.answer("s1", "silpo", true)).toBe("connected");
		expect(access.connected).toEqual([{ id: "s1", flags: ["silpo"] }]);
		expect((await store.session("s1"))?.silpo).toBe(true);
		expect(told[0]).toContain("інструкція silpo");
		await expect(mcp.answer("zzz", "silpo", true)).rejects.toThrow("unknown session");
	});

	it("прапорці й примітка про відсутній вхід на старті", () => {
		expect(Mcp.flags({ sure: true, silpo: undefined, calendar: { access: "t" } })).toEqual({ sure: true, calendar: true });
		expect(Mcp.missing({ silpo: true, sure: true }, { sure: true })).toHaveLength(1);
	});
});

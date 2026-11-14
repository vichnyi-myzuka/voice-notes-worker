import { describe, expect, it } from "vitest";
import { requestedMcp } from "../src/infrastructure/container/mcp";

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

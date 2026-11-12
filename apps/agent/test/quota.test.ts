import { afterEach, describe, expect, it, vi } from "vitest";
import { describeQuota, fetchQuota, parseQuota } from "../src/infrastructure/quota";

const headers = (extra: Record<string, string> = {}) =>
	new Headers({
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-5h-utilization": "0.63",
		"anthropic-ratelimit-unified-5h-reset": "1000",
		"anthropic-ratelimit-unified-7d-utilization": "0.18",
		"anthropic-ratelimit-unified-7d-reset": String(2 * 86400 + 3 * 3600),
		...extra,
	});

afterEach(() => vi.unstubAllGlobals());

describe("ліміти Claude", () => {
	it("розбирає заголовки обох вікон", () => {
		expect(parseQuota(headers())).toEqual({
			fiveHour: { utilization: 0.63, resetAt: 1000 },
			sevenDay: { utilization: 0.18, resetAt: 2 * 86400 + 3 * 3600 },
			status: "allowed",
		});
		expect(parseQuota(new Headers())).toEqual({ fiveHour: undefined, sevenDay: undefined, status: undefined });
	});

	it("форматує відсотки й час до скидання", () => {
		const text = describeQuota(parseQuota(headers()), 1000 * (1000 - 2 * 3600 - 10 * 60));
		expect(text).toBe(
			"📊 Ліміти Claude\n\n5 годин\n█████████████░░░░░░░ 63%\nскидання через 2 год 10 хв\n\nТиждень\n████░░░░░░░░░░░░░░░░ 18%\nскидання через 2 дн 4 год",
		);
		expect(describeQuota(parseQuota(headers({ "anthropic-ratelimit-unified-status": "rejected" })), 0)).toContain("⛔");
	});

	it("робить мінімальний запит з токеном підписки і читає заголовки", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { headers: headers() }));
		vi.stubGlobal("fetch", fetchMock);
		expect((await fetchQuota("tok")).fiveHour?.utilization).toBe(0.63);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
		expect(JSON.parse(init.body as string).max_tokens).toBe(1);
	});

	it("відповідь без заголовків ліміту — помилка", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
		await expect(fetchQuota("bad")).rejects.toThrow("quota 401");
	});
});

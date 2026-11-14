import { describe, expect, it } from "vitest";
import { adrDecision, firstHeading, parseMerges, plain, summarizeWrangler } from "../scripts/lib";

describe("розбір документів", () => {
	it("заголовок і рішення ADR без розмітки", () => {
		const md = "# Один DO\n\n**Рішення.** `apps/agent` має [один](x.md) **Durable Object**.\n\n**Чому.** дешевше";
		expect(firstHeading(md, "f")).toBe("Один DO");
		expect(adrDecision(md)).toBe("apps/agent має один Durable Object.");
		expect(adrDecision("# X")).toBe("");
		expect(firstHeading("текст", "fallback")).toBe("fallback");
		expect(plain("**a**  `b`\nc")).toBe("a b c");
	});

	it("мержі з тіла коміту", () => {
		expect(parseMerges("2026-11-14\tfeat: X\n2026-11-13\t\n")).toEqual([{ date: "2026-11-14", title: "feat: X" }]);
	});
});

describe("wrangler", () => {
	it("лише прив'язки, без змінних і коментарів", () => {
		const toml = `name = "w"\n# c\n[vars]\nSECRET_LIKE = "x"\n[[r2_buckets]]\nbinding = "B"\nbucket_name = "b" # c\n[observability]\nenabled = true`;
		expect(summarizeWrangler(toml)).toBe(`  name = "w"\n[[r2_buckets]]\n  binding = "B"\n  bucket_name = "b"\n[observability]`);
	});
});

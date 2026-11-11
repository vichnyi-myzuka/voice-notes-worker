import { describe, expect, it } from "vitest";
import { describeActivity } from "../src/infrastructure/container/activity";

describe("describeActivity", () => {
	it("файли: шлях без теки сесії", () => {
		expect(describeActivity("edit", { filePath: "/workspace/sessions/docs-1/README.md" })).toBe("редагує README.md");
		expect(describeActivity("read", { filePath: "/workspace/repos/me/app/src/a.ts" })).toBe("читає src/a.ts");
		expect(describeActivity("write", {})).toBe("редагує файл");
	});

	it("bash: лише назва програми (у команді можуть бути токени)", () => {
		expect(describeActivity("bash", { command: "curl -H 'Authorization: Bearer abc' https://x" })).toBe("виконує curl");
		expect(describeActivity("bash", {})).toBe("виконує команду");
	});

	it("пошук, мережа, невідомий інструмент; довгі значення скорочуються", () => {
		expect(describeActivity("grep", { pattern: "TODO" })).toBe("шукає TODO");
		expect(describeActivity("webfetch", { url: "https://example.com/a" })).toBe("відкриває example.com/a");
		expect(describeActivity("custom", undefined)).toBe("інструмент custom");
		expect(describeActivity("read", { filePath: `a/${"x".repeat(100)}` })).toHaveLength("читає ".length + 60);
	});
});

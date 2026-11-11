import { describe, expect, it } from "vitest";
import { describeActivity, describeForm } from "../src/infrastructure/container/activity";

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

describe("describeForm", () => {
	it("заголовок, поля й варіанти відповіді; підказка, як відповісти", () => {
		const text = describeForm({ title: "Який стиль?", fields: [{ title: "Стиль", options: [{ label: "Мінімалізм", description: "світлий" }, { label: "Яскравий" }] }] });
		expect(text).toBe("❓ Який стиль?\nСтиль\n• Мінімалізм: світлий\n• Яскравий\n\nВідповідай на цей пост.");
	});

	it("поле з тим самим заголовком не дублюється; порожня форма й надто довгий текст", () => {
		expect(describeForm({ title: "Так чи ні?", fields: [{ title: "Так чи ні?" }] })).toBe("❓ Так чи ні?\n\nВідповідай на цей пост.");
		expect(describeForm({})).toContain("Агент питає");
		expect(describeForm({ title: "x".repeat(3000) }).length).toBeLessThanOrEqual(1201);
		expect(describeActivity("question", {})).toBe("ставить питання");
	});
});

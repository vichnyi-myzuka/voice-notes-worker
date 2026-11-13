import type { Llm } from "@voice-notes/core";
import { describe, expect, it, vi } from "vitest";
import { TITLE_MAX, cleanTitle, retitle } from "../src/infrastructure/container/title";

const llmReturning = (title: unknown): Llm & { requests: { user: string }[] } => {
	const requests: { user: string }[] = [];
	return {
		requests,
		transcribe: async () => "",
		askJson: async (req, parse) => {
			requests.push(req);
			return parse(JSON.stringify({ title }));
		},
	};
};

describe("cleanTitle", () => {
	it("прибирає лапки, крапку й зайві пробіли, обрізає довге", () => {
		expect(cleanTitle(' «Семантичні   назви тем». ')).toBe("Семантичні назви тем");
		expect(cleanTitle("а".repeat(100))).toHaveLength(TITLE_MAX);
	});

	it("порожнє чи не рядок — undefined", () => {
		expect(cleanTitle(" . ")).toBeUndefined();
		expect(cleanTitle(5)).toBeUndefined();
	});
});

describe("retitle", () => {
	it("дає моделі поточну назву, завдання, уточнення й результат без токенів", async () => {
		const llm = llmReturning("Нова назва");
		expect(await retitle(llm, "Стара назва", "Зроби X token=hunter2hunter2", "А тепер Y", "✅ Готово")).toBe("Нова назва");
		const user = llm.requests[0].user;
		expect(user).toContain("<current_title>Стара назва</current_title>");
		expect(user).toContain("А тепер Y");
		expect(user).toContain("✅ Готово");
		expect(user).not.toContain("hunter2hunter2");
	});

	it("збій моделі чи порожня відповідь — undefined", async () => {
		const failing: Llm = { transcribe: async () => "", askJson: async () => Promise.reject(new Error("boom")) };
		expect(await retitle(failing, "a", "t", undefined, "r")).toBeUndefined();
		expect(await retitle(llmReturning(""), "a", "t", undefined, "r")).toBeUndefined();
	});

	it("тайм-аут моделі — undefined", async () => {
		vi.useFakeTimers();
		try {
			const hanging: Llm = { transcribe: async () => "", askJson: () => new Promise(() => {}) };
			const result = retitle(hanging, "a", "t", undefined, "r");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await result).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

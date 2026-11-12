import type { Llm } from "@voice-notes/core";
import { describe, expect, it, vi } from "vitest";
import { describeCall, narrate, redact, remember } from "../src/infrastructure/container/narrate";

const llmReturning = (status: unknown): Llm & { requests: { user: string }[] } => {
	const requests: { user: string }[] = [];
	return {
		requests,
		transcribe: async () => "",
		askJson: async (req, parse) => {
			requests.push(req);
			return parse(JSON.stringify({ status }));
		},
	};
};

describe("redact", () => {
	it("прибирає значення токенів і довгі ключоподібні рядки", () => {
		expect(redact("curl -H 'Authorization: Bearer abc123' x")).not.toContain("abc123");
		expect(redact("TOKEN=supersecret npm run x")).toBe("TOKEN=*** npm run x");
		expect(redact("git push https://ghp_abcdefghij1234@github.com")).not.toContain("ghp_abcdefghij1234");
		expect(redact(`echo ${"a".repeat(40)}`)).toBe("echo ***");
		expect(redact("npm run check")).toBe("npm run check");
	});
});

describe("describeCall", () => {
	it("дає моделі більше контексту, ніж підпис у пості", () => {
		expect(describeCall("bash", { command: "npm test -- activity\nrm -rf x", description: "Runs the activity tests" })).toBe("bash: Runs the activity tests");
		expect(describeCall("bash", { command: "TOKEN=abc12345 npm test" })).toBe("bash: TOKEN=*** npm test");
		expect(describeCall("grep", { pattern: "describeActivity" })).toBe("grep: describeActivity");
		expect(describeCall("read", { filePath: "/workspace/sessions/x-1/src/a.ts" })).toBe("read: src/a.ts");
		expect(describeCall("custom", undefined)).toBe("custom");
	});
});

describe("remember", () => {
	it("лишає лише останні дії", () => {
		const list = Array.from({ length: 12 }, (_, i) => String(i)).reduce(remember, [] as string[]);
		expect(list).toEqual(["4", "5", "6", "7", "8", "9", "10", "11"]);
	});
});

describe("narrate", () => {
	it("передає моделі завдання, дії й попередній опис, повертає очищений текст", async () => {
		const llm = llmReturning("  перевіряє, як формується підпис.\n");
		expect(await narrate(llm, "Поправ підписи", ["grep: describeActivity", "read: src/a.ts"], "шукає підписи")).toBe("перевіряє, як формується підпис");
		const user = llm.requests[0].user;
		expect(user).toContain("Поправ підписи");
		expect(user).toContain("- grep: describeActivity\n- read: src/a.ts");
		expect(user).toContain("<previous_status>шукає підписи</previous_status>");
	});

	it("не питає модель без дій; порожню чи нестрокову відповідь відкидає", async () => {
		const llm = llmReturning("x");
		expect(await narrate(llm, "t", [])).toBeUndefined();
		expect(llm.requests).toHaveLength(0);
		expect(await narrate(llmReturning(" . "), "t", ["a"])).toBeUndefined();
		expect(await narrate(llmReturning(5), "t", ["a"])).toBeUndefined();
	});

	it("завдання з токеном до моделі не потрапляє", async () => {
		const llm = llmReturning("ok");
		await narrate(llm, "використай token=hunter2hunter2", ["a"]);
		expect(llm.requests[0].user).not.toContain("hunter2");
	});

	it("збій чи тайм-аут моделі дають undefined", async () => {
		const failing: Llm = { transcribe: async () => "", askJson: async () => Promise.reject(new Error("boom")) };
		expect(await narrate(failing, "t", ["a"])).toBeUndefined();
		vi.useFakeTimers();
		try {
			const hanging: Llm = { transcribe: async () => "", askJson: () => new Promise(() => {}) };
			const result = narrate(hanging, "t", ["a"]);
			await vi.advanceTimersByTimeAsync(5000);
			expect(await result).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

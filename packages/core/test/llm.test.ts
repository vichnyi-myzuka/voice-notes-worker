import { afterEach, describe, expect, it, vi } from "vitest";
import { askLuna, toBase64 } from "../src/infrastructure/llm/ask";
import { whisper } from "../src/infrastructure/llm/transcribe";

describe("toBase64", () => {
	it("збігається з Buffer для буфера більшого за 0x8000 байтів", () => {
		const bytes = new Uint8Array(0x8000 * 3 + 123).map((_, i) => (i * 31) % 256);
		expect(toBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
	});
});

describe("askLuna", () => {
	afterEach(() => vi.unstubAllGlobals());

	const ask = (output: unknown) => {
		vi.stubGlobal("fetch", async () => Response.json({ output }));
		return askLuna({ OPENAI_API_KEY: "k" } as never, { name: "n", system: "s", user: "u", schema: {} });
	};
	const part = (text: string) => ({ type: "output_text", text });

	it("бере лише першу текстову частину, коли модель повторила відповідь", async () => {
		const json = '{"status":"ok"}';
		expect(await ask([{ type: "message", content: [part(json), part(json)] }])).toBe(json);
		expect(await ask([{ type: "message", content: [part(json)] }, { type: "message", content: [part(json)] }])).toBe(json);
	});

	it("повертає порожній рядок без текстових частин", async () => {
		expect(await ask([{ type: "reasoning" }])).toBe("");
	});
});

describe("whisper", () => {
	afterEach(() => vi.restoreAllMocks());

	it("логує розмір, час і довжину тексту, але не весь транскрипт", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const env = { AI: { run: async () => ({ text: " Привіт, світе " }) } } as never;
		expect(await whisper(env, new ArrayBuffer(2000), "audio/ogg")).toBe("Привіт, світе");
		const lines = log.mock.calls.map((c) => String(c[0]));
		expect(lines[0]).toContain("whisper: start audio/ogg, 2 КБ");
		expect(lines[1]).toMatch(/whisper: ok audio\/ogg, 2 КБ, \d+ms, 13 символів/);
	});

	it("логує помилку і кидає її далі", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const env = { AI: { run: async () => Promise.reject(new Error("quota")) } } as never;
		await expect(whisper(env, new ArrayBuffer(10), "audio/ogg")).rejects.toThrow("quota");
		expect(String(error.mock.calls[0]![0])).toContain("whisper: failed");
	});
});

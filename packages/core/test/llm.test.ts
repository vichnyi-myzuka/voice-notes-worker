import { afterEach, describe, expect, it, vi } from "vitest";
import { askLuna, toBase64 } from "../src/infrastructure/llm/ask";

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

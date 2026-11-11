import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/infrastructure/llm";

describe("toBase64", () => {
	it("збігається з Buffer для буфера більшого за 0x8000 байтів", () => {
		const bytes = new Uint8Array(0x8000 * 3 + 123).map((_, i) => (i * 31) % 256);
		expect(toBase64(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
	});
});

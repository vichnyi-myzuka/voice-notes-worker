import { afterEach, describe, expect, it, vi } from "vitest";
import { stamp, stopwatch } from "../src/timing";

describe("stopwatch", () => {
	afterEach(() => vi.restoreAllMocks());

	it("виводить один рядок latency з етапами, мітками часу й загальним часом", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		let t = Date.parse("2026-11-14T10:00:00.000Z");
		const sw = stopwatch("telegram 1/2", () => t);
		t += 120;
		sw.mark("transcribe");
		t += 30;
		sw.mark("route");
		sw.log({ kind: "voice", skipped: undefined });
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("latency telegram 1/2: start=2026-11-14T10:00:00.000Z kind=voice transcribe=120ms route=30ms end=2026-11-14T10:00:00.150Z total=150ms");
	});

	it("stamp дає ISO-час у UTC", () => {
		expect(stamp(0)).toBe("1970-01-01T00:00:00.000Z");
	});
});

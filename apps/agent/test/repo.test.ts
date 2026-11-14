import { describe, expect, it } from "vitest";
import { settedRepo } from "../src/infrastructure/container/repo";

describe("settedRepo", () => {
	it("бачить `set-repo owner/name` у команді bash (також у ланцюжку), а іншу команду чи кривий аргумент — ні", () => {
		expect(settedRepo({ command: "set-repo acme/voice-notes" })).toBe("acme/voice-notes");
		expect(settedRepo({ command: "cd /workspace/sessions/x && set-repo acme/a.b_c-d; ls" })).toBe("acme/a.b_c-d");
		expect(settedRepo({ command: 'set-repo "acme/app"' })).toBe("acme/app");
		expect(settedRepo({ command: "set-repo acme" })).toBeUndefined();
		expect(settedRepo({ command: "set-repo acme/app/extra" })).toBeUndefined();
		expect(settedRepo({ command: "echo reset-repo acme/app" })).toBeUndefined();
		expect(settedRepo({ command: "git status" })).toBeUndefined();
		expect(settedRepo({})).toBeUndefined();
		expect(settedRepo(undefined)).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { handedOff, handoffId } from "../src/infrastructure/container/jobs/handoff";

describe("handedOff", () => {
	it("бере текст задачі з heredoc і прапорці --repo/--name", () => {
		expect(handedOff({ command: "handoff <<'EOF'\nЗроби X\nу два рядки\nEOF" })).toEqual({ task: "Зроби X\nу два рядки" });
		expect(handedOff({ command: "handoff --repo acme/app --name fix-login <<'EOF'\nTask\nEOF\n" })).toEqual({ task: "Task", repo: "acme/app", name: "fix-login" });
		expect(handedOff({ command: "cd /tmp && handoff --repo=none <<EOF\nTask\nEOF" })).toEqual({ task: "Task", repo: null });
	});

	it("кривий репозиторій чи назву ігнорує, а не-handoff, порожній текст і pipe — ні", () => {
		expect(handedOff({ command: "handoff --repo bad --name Bad_Name <<'EOF'\nTask\nEOF" })).toEqual({ task: "Task" });
		expect(handedOff({ command: "handoff <<'EOF'\n  \nEOF" })).toBeUndefined();
		expect(handedOff({ command: 'echo "Task" | handoff' })).toBeUndefined();
		expect(handedOff({ command: "echo nohandoff <<'EOF'\nTask\nEOF" })).toBeUndefined();
		expect(handedOff({ command: "git status" })).toBeUndefined();
		expect(handedOff(undefined)).toBeUndefined();
	});

	it("id нової сесії стабільний для виклику й різний для різних викликів", () => {
		expect(handoffId("tg-1-2", "call_a")).toBe(handoffId("tg-1-2", "call_a"));
		expect(handoffId("tg-1-2", "call_a")).not.toBe(handoffId("tg-1-2", "call_b"));
		expect(handoffId("tg-1-2", "call_a")).toMatch(/^tg-1-2-h[0-9a-z]+$/);
	});
});

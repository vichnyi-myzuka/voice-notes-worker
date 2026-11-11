/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLEANUP } from "../src/infrastructure/container/cleanup";

// Справжній git: «GitHub» (bare), спільний клон і worktree сесії в /workspace/sessions-подібній теці.
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function setup() {
	const root = mkdtempSync(join(tmpdir(), "cleanup-"));
	const origin = join(root, "origin.git");
	const base = join(root, "repos/me/app");
	mkdirSync(base, { recursive: true });
	git(root, "init", "--bare", "-b", "main", origin);
	git(root, "clone", origin, base);
	git(base, "commit", "--allow-empty", "-m", "init");
	git(base, "push", "origin", "main");
	git(base, "remote", "set-head", "origin", "main");
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	const start = (name: string) => {
		git(base, "worktree", "add", "--no-track", "-b", `agent/${name}`, join(sessions, name), "main");
		return join(sessions, name);
	};
	// CLEANUP бере теку з /workspace/sessions/<назва>: підміняємо префікс на тимчасову теку
	const cleanup = (name: string) => execFileSync("sh", ["-c", CLEANUP.replace("/workspace/sessions/", `${sessions}/`), "sh", name]);
	const branches = () => git(base, "branch", "--format=%(refname:short)").split("\n");
	return { base, sessions, start, cleanup, branches, commit: (dir: string) => git(dir, "commit", "--allow-empty", "-m", "work") };
}

describe("прибирання сесії в контейнері", () => {
	it("порожня гілка (нічого не закомічено): worktree і гілка видаляються", () => {
		const t = setup();
		const dir = t.start("fix-a-1");
		t.cleanup("fix-a-1");
		expect(existsSync(dir)).toBe(false);
		expect(t.branches()).not.toContain("agent/fix-a-1");
	});

	it("коміти запушено: worktree і гілка видаляються", () => {
		const t = setup();
		const dir = t.start("feat-b-2");
		t.commit(dir);
		git(dir, "push", "origin", "agent/feat-b-2");
		t.cleanup("feat-b-2");
		expect(existsSync(dir)).toBe(false);
		expect(t.branches()).not.toContain("agent/feat-b-2");
	});

	it("незапушені коміти: worktree видаляється, а гілка лишається (робота не втрачається)", () => {
		const t = setup();
		const dir = t.start("feat-c-3");
		t.commit(dir);
		t.cleanup("feat-c-3");
		expect(existsSync(dir)).toBe(false);
		expect(t.branches()).toContain("agent/feat-c-3");
	});

	it("запушено, але потім ще коміт без пушу: гілка лишається", () => {
		const t = setup();
		const dir = t.start("feat-d-4");
		t.commit(dir);
		git(dir, "push", "origin", "agent/feat-d-4");
		t.commit(dir);
		t.cleanup("feat-d-4");
		expect(t.branches()).toContain("agent/feat-d-4");
	});

	it("тека без репозиторію просто видаляється; чужі теки й гілки не чіпаються", () => {
		const t = setup();
		const plain = join(t.sessions, "empty-5");
		mkdirSync(plain);
		const other = t.start("feat-e-6");
		t.cleanup("empty-5");
		expect(existsSync(plain)).toBe(false);
		expect(existsSync(other)).toBe(true);
		expect(t.branches()).toContain("agent/feat-e-6");
	});

	it("гілка не з простору agent/ ніколи не видаляється", () => {
		const t = setup();
		git(t.base, "branch", "feature/x");
		const dir = join(t.sessions, "odd-7");
		git(t.base, "worktree", "add", dir, "feature/x");
		t.cleanup("odd-7");
		expect(existsSync(dir)).toBe(false);
		expect(t.branches()).toContain("feature/x");
	});
});

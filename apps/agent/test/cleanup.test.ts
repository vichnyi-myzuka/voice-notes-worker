/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLEANUP } from "../src/infrastructure/container/cleanup";

// Справжній git: «GitHub» (bare), спільний клон і worktree сесії в /workspace/sessions-подібній теці. Хуки вимкнено: системний pre-push (агент) забороняє пуш у main, а тест пушить у власний тимчасовий bare-репозиторій.
// У git-хуку (pre-push) git виставляє GIT_DIR тощо: без очищення тест працював би з реальним репозиторієм.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

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
	// publish — заглушка, що лише записує, які сайти їй наказали видалити; список сайтів сесії лежить у published/<назва>
	const bin = join(root, "bin");
	const published = join(root, "published");
	const deleted = join(root, "deleted.log");
	mkdirSync(bin);
	mkdirSync(published);
	writeFileSync(join(bin, "publish"), `#!/bin/sh\n[ "$2" = broken ] && exit 1\necho "$@" >> "${deleted}"\n`);
	chmodSync(join(bin, "publish"), 0o755);
	const cleanup = (name: string) =>
		execFileSync("sh", ["-c", CLEANUP.replace("/workspace/sessions/", `${sessions}/`).replace("/workspace/published/", `${published}/`), "sh", name], { env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}` } });
	const sitesOf = (name: string, sites: string[]) => writeFileSync(join(published, name), sites.join("\n") + "\n");
	const deletedSites = () => (existsSync(deleted) ? readFileSync(deleted, "utf8").trim().split("\n") : []);
	const branches = () => git(base, "branch", "--format=%(refname:short)").split("\n");
	return { base, sessions, start, cleanup, branches, sitesOf, deletedSites, published, commit: (dir: string) => git(dir, "commit", "--allow-empty", "-m", "work") };
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

	it("сайти сесії видаляються (publish --delete), список прибирається; чужі сайти не чіпаються", () => {
		const t = setup();
		t.start("feat-s-7");
		t.start("feat-t-8");
		t.sitesOf("feat-s-7", ["demo", "report"]);
		t.sitesOf("feat-t-8", ["other"]);
		t.cleanup("feat-s-7");
		expect(t.deletedSites()).toEqual(["--delete demo", "--delete report"]);
		expect(existsSync(join(t.published, "feat-s-7"))).toBe(false);
		expect(existsSync(join(t.published, "feat-t-8"))).toBe(true); // чужий список лишається
	});

	it("збій видалення одного сайту не зупиняє прибирання: решта сайтів, worktree і гілка", () => {
		const t = setup();
		const dir = t.start("feat-u-9");
		t.sitesOf("feat-u-9", ["broken", "fine"]);
		t.cleanup("feat-u-9");
		expect(t.deletedSites()).toEqual(["--delete fine"]);
		expect(existsSync(dir)).toBe(false);
		expect(t.branches()).not.toContain("agent/feat-u-9");
	});

	it("сесія без опублікованих сайтів прибирається як раніше", () => {
		const t = setup();
		t.start("fix-v-10");
		t.cleanup("fix-v-10");
		expect(t.deletedSites()).toEqual([]);
	});
});

/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// `publish` викликає rclone: підставляємо фейковий, що лише записує аргументи й змінні віддаленого сховища.
const SCRIPT = join(import.meta.dirname, "../payload/publish.sh");
let bin: string;
let log: string;

beforeAll(() => {
	const root = mkdtempSync(join(tmpdir(), "publish-"));
	bin = join(root, "bin");
	log = join(root, "rclone.log");
	mkdirSync(bin);
	writeFileSync(join(bin, "rclone"), `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = lsf ] && printf 'alpha/\\nbeta/\\n'\nexit 0\n`);
	chmodSync(join(bin, "rclone"), 0o755);
});

const env = {
	R2_ACCESS_KEY_ID: "k",
	R2_SECRET_ACCESS_KEY: "s",
	R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
	SITES_BASE_URL: "https://sites.example",
};

function run(args: string[], extra: Record<string, string> = {}, cwd?: string) {
	try {
		const stdout = execFileSync("sh", [SCRIPT, ...args], { cwd, env: { PATH: `${bin}:${process.env.PATH}`, ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] }).toString();
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { status: number; stderr: Buffer; stdout: Buffer };
		return { code: e.status, stdout: e.stdout.toString(), stderr: e.stderr.toString() };
	}
}

const site = (files: Record<string, string> = { "index.html": "<h1>hi</h1>" }) => {
	const dir = mkdtempSync(join(tmpdir(), "site-"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
};
const calls = () => readFileSync(log, "utf8").trim().split("\n");

describe("publish", () => {
	it("синхронізує теку в бакет, виключає приховані файли й node_modules, друкує URL", () => {
		writeFileSync(log, "");
		const res = run([site(), "my-demo"]);
		expect(res.code).toBe(0);
		expect(res.stdout.trim()).toBe("https://sites.example/my-demo/");
		expect(calls()[0]).toMatch(/^sync \S+ sites:agent-sites\/my-demo --exclude \.\* --exclude \.\*\/\*\* --exclude node_modules\/\*\* --max-size 20M$/);
	});

	it("відхиляє погані назви, відсутню теку й теку без index.html, нічого не завантажуючи", () => {
		writeFileSync(log, "");
		for (const name of ["A", "-x", "a", "my_demo", "a/b", "..", "x".repeat(41)]) expect(run([site(), name]).code, name).toBe(2);
		expect(run(["/no/such/dir", "demo"]).stderr).toContain("not a directory");
		expect(run([site({ "page.html": "x" }), "demo"]).stderr).toContain("index.html is missing");
		expect(readFileSync(log, "utf8")).toBe("");
	});

	it("відхиляє сайт понад ліміт розміру", () => {
		const big = site({ "index.html": "x", "big.bin": "0".repeat(52 * 1024 * 1024) });
		expect(run([big, "big-site"]).stderr).toContain("limit");
	});

	it("--list і --delete працюють з бакетом; --delete перевіряє назву", () => {
		writeFileSync(log, "");
		expect(run(["--list"]).stdout.trim().split("\n")).toEqual(["alpha", "beta"]);
		expect(run(["--delete", "alpha"]).code).toBe(0);
		expect(calls()).toContain("purge sites:agent-sites/alpha");
		expect(run(["--delete", "../x"]).code).toBe(2);
	});

	it("без налаштованого R2 пояснює, чого бракує", () => {
		const res = run([site(), "demo"], { R2_ACCESS_KEY_ID: "" });
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("R2_ACCESS_KEY_ID is not set");
	});

	describe("--public: публічний бакет", () => {
		const pub = { PUBLIC_R2_ACCESS_KEY_ID: "pk", PUBLIC_R2_SECRET_ACCESS_KEY: "ps", PUBLIC_SITES_BASE_URL: "https://share.example" };

		it("кладе сайт у публічний бакет з окремим ключем і друкує публічну адресу", () => {
			writeFileSync(log, "");
			const res = run(["--public", site(), "card"], pub);
			expect(res.code).toBe(0);
			expect(res.stdout.trim()).toBe("https://share.example/card/");
			expect(calls()[0]).toMatch(/ sites:agent-sites-public\/card /);
			expect(calls().join("\n")).not.toContain("sites:agent-sites/");
		});

		it("--list і --delete працюють з публічним бакетом", () => {
			writeFileSync(log, "");
			expect(run(["--public", "--list"], pub).code).toBe(0);
			expect(run(["--public", "--delete", "card"], pub).code).toBe(0);
			expect(calls()).toContain("lsf --dirs-only sites:agent-sites-public");
			expect(calls()).toContain("purge sites:agent-sites-public/card");
		});

		it("без публічних змінних не публікує (і не підставляє приватний ключ)", () => {
			writeFileSync(log, "");
			const res = run(["--public", site(), "card"]);
			expect(res.code).toBe(1);
			expect(res.stderr).toContain("PUBLIC_R2_ACCESS_KEY_ID is not set");
			expect(readFileSync(log, "utf8")).toBe("");
		});

		it("публічний сайт не належить сесії: /delete його не зачепить", () => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "pub-")));
			const sessions = join(root, "sessions");
			const published = join(root, "published");
			mkdirSync(join(sessions, "docs-1"), { recursive: true });
			run(["--public", site(), "card"], { ...pub, SESSIONS_ROOT: sessions, PUBLISHED_DIR: published }, join(sessions, "docs-1"));
			expect(existsSync(published)).toBe(false);
		});
	});

	describe("кому належить сайт (для /delete сесії)", () => {
		// Тека сесій і список належності підміняються змінними, як /workspace у контейнері.
		const world = () => {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "own-"))); // справжній шлях: на macOS /var є посиланням на /private/var, а sh бере cwd без посилань
			const sessions = join(root, "sessions");
			const published = join(root, "published");
			for (const s of ["docs-1", "feat-2"]) mkdirSync(join(sessions, s, "site"), { recursive: true });
			const x = { SESSIONS_ROOT: sessions, PUBLISHED_DIR: published };
			const listOf = (s: string) => (existsSync(join(published, s)) ? readFileSync(join(published, s), "utf8").trim().split("\n").filter(Boolean) : []);
			return { sessions, x, listOf, inSession: (s: string) => join(sessions, s, "site") };
		};

		it("публікація з теки сесії записує назву в її список (без дублів)", () => {
			const w = world();
			expect(run([site(), "demo"], w.x, w.inSession("docs-1")).code).toBe(0);
			expect(run([site(), "demo"], w.x, w.inSession("docs-1")).code).toBe(0);
			expect(run([site(), "other"], w.x, w.inSession("docs-1")).code).toBe(0);
			expect(w.listOf("docs-1")).toEqual(["demo", "other"]);
		});

		it("перепублікація тієї ж назви з іншої сесії забирає сайт: стара сесія його вже не видалить", () => {
			const w = world();
			run([site(), "demo"], w.x, w.inSession("docs-1"));
			run([site(), "demo"], w.x, w.inSession("feat-2"));
			expect(w.listOf("docs-1")).toEqual([]);
			expect(w.listOf("feat-2")).toEqual(["demo"]);
		});

		it("publish --delete знімає назву зі списку", () => {
			const w = world();
			run([site(), "demo"], w.x, w.inSession("docs-1"));
			expect(run(["--delete", "demo"], w.x, w.inSession("docs-1")).code).toBe(0);
			expect(w.listOf("docs-1")).toEqual([]);
		});

		it("поза текою сесії (наприклад, через SSH) сайт публікується, але нікому не належить", () => {
			const w = world();
			expect(run([site(), "manual"], w.x, tmpdir()).code).toBe(0);
			expect(w.listOf("docs-1")).toEqual([]);
			expect(existsSync(join(w.x.PUBLISHED_DIR, "docs-1"))).toBe(false);
		});

		it("невдала публікація нікому не записується", () => {
			const w = world();
			expect(run([site({ "page.html": "x" }), "bad-site"], w.x, w.inSession("docs-1")).code).toBe(2);
			expect(w.listOf("docs-1")).toEqual([]);
		});
	});
});


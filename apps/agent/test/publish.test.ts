/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// `publish` викликає rclone: підставляємо фейковий, що лише записує аргументи й змінні віддаленого сховища.
const SCRIPT = join(import.meta.dirname, "../container/publish");
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

function run(args: string[], extra: Record<string, string> = {}) {
	try {
		const stdout = execFileSync("sh", [SCRIPT, ...args], { env: { PATH: `${bin}:${process.env.PATH}`, ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] }).toString();
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
});

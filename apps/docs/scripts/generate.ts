// Збирає web/src/generated.json зі сховища: модулі застосунків, прив'язки, ADR, документи, останні мержі.
// Запускається перед збіркою (`npm run generate`); файл у git не потрапляє.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adrDecision, firstHeading, parseMerges, summarizeWrangler, type AppData, type Generated, type Module } from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const ls = (p: string) => readdirSync(join(root, p), { withFileTypes: true });

const git = (...args: string[]) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};

// Теки з кодом і файлами в них (без тестів і node_modules).
function walk(base: string, rel = ""): Module[] {
	const entries = ls(join(base, rel));
	const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
	const dirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules" && e.name !== "test").sort((a, b) => a.name.localeCompare(b.name));
	return [...(files.length ? [{ dir: rel, files }] : []), ...dirs.flatMap((d) => walk(base, join(rel, d.name)))];
}

const apps: AppData[] = [];
for (const [group, kind] of [["apps", "app"], ["packages", "package"]] as const) {
	for (const e of ls(group)) {
		if (!e.isDirectory()) continue;
		const name = `${group}/${e.name}`;
		let modules: Module[];
		try {
			modules = walk(`${name}/src`);
		} catch {
			continue; // немає src
		}
		let bindings = "";
		try {
			bindings = summarizeWrangler(read(`${name}/wrangler.toml`));
		} catch {
			// пакети без wrangler.toml
		}
		apps.push({ name, kind, modules, bindings });
	}
}

const mdFiles = (dir: string) => ls(dir).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => `${dir}/${e.name}`).sort();
const docPaths = ["README.md", "GLOSSARY.md", "AGENTS.md", ...mdFiles("docs"), ...mdFiles("docs/agents")];

const data: Generated = {
	sha: process.env.GITHUB_SHA || git("rev-parse", "HEAD") || "unknown",
	date: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
	repoUrl: `https://github.com/${process.env.GITHUB_REPOSITORY || "vichnyi-myzuka/voice-notes-worker"}`,
	apps,
	adrs: mdFiles("docs/adr").map((path) => ({ file: path, title: firstHeading(read(path), path), decision: adrDecision(read(path)) })),
	docs: docPaths.map((path) => ({ path, title: firstHeading(read(path), path) })),
	merges: parseMerges(git("log", "--merges", "-n", "12", "--format=%cs%x09%b")),
};

writeFileSync(join(root, "apps/docs/web/src/generated.json"), JSON.stringify(data, null, 1));
console.log(`docs: дані зібрано (${apps.length} застосунків і пакетів, ${data.adrs.length} ADR, коміт ${data.sha.slice(0, 7)})`);

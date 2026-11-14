// Збірка сайту документації: `npm run build` → dist/ (запускає node зі стриптайпом, див. package.json).
// Джерела: README.md, GLOSSARY.md, AGENTS.md, docs/**/*.md та код репозиторію (знімок).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	firstHeading,
	pageGroup,
	pageSlug,
	renderMarkdown,
	renderPage,
	snapshotMarkdown,
	summarizeWrangler,
	type AppSnapshot,
	type Merge,
	type Meta,
	type Page,
} from "./lib.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "apps/docs/dist");

const git = (...args: string[]) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};

const read = (p: string) => readFileSync(join(root, p), "utf8");
const ls = (p: string) => readdirSync(join(root, p), { withFileTypes: true });

function markdownSources(): string[] {
	const files = ["docs/architecture.md", "README.md", "GLOSSARY.md", "AGENTS.md"];
	for (const dir of ["docs", "docs/adr", "docs/agents"]) {
		for (const e of ls(dir)) if (e.isFile() && e.name.endsWith(".md")) files.push(`${dir}/${e.name}`);
	}
	return [...new Set(files)];
}

// Теки з кодом і файлами в них (без тестів і node_modules).
function walk(base: string, rel = ""): { dir: string; files: string[] }[] {
	const entries = ls(join(base, rel));
	const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
	const dirs = entries.filter((e) => e.isDirectory() && e.name !== "node_modules" && e.name !== "test").sort((a, b) => a.name.localeCompare(b.name));
	return [...(files.length ? [{ dir: rel, files }] : []), ...dirs.flatMap((d) => walk(base, join(rel, d.name)))];
}

function snapshot(): AppSnapshot[] {
	const result: AppSnapshot[] = [];
	for (const group of ["apps", "packages"]) {
		for (const e of ls(group)) {
			if (!e.isDirectory()) continue;
			const name = `${group}/${e.name}`;
			let dirs: AppSnapshot["dirs"] = [];
			try {
				dirs = walk(join(root, name, "src"));
			} catch {
				continue; // немає src
			}
			let bindings = "";
			try {
				bindings = summarizeWrangler(read(`${name}/wrangler.toml`));
			} catch {
				// пакети без wrangler.toml
			}
			result.push({ name, dirs, bindings });
		}
	}
	return result;
}

function recentMerges(): Merge[] {
	return git("log", "--merges", "-n", "15", "--format=%cs%x09%b")
		.split("\n")
		.map((l) => l.split("\t"))
		.filter((p): p is [string, string] => Boolean(p[0] && p[1]))
		.map(([date, title]) => ({ date, title }));
}

const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY || "vichnyi-myzuka/voice-notes-worker"}`;
const meta: Meta = {
	sha: process.env.GITHUB_SHA || git("rev-parse", "HEAD") || "unknown",
	date: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
	repoUrl,
};

const sources = markdownSources();
const pages: Page[] = sources.map((src) => ({ src, slug: pageSlug(src), title: firstHeading(read(src), src), group: pageGroup(src) }));
const snapshotPage: Page = { src: "apps/docs/build/index.ts", slug: "snapshot", title: "Знімок коду", group: "Архітектура" };
pages.splice(1, 0, snapshotPage);

const byPath = new Map(pages.map((p) => [p.src, p]));

rmSync(out, { recursive: true, force: true });
const write = (slug: string, html: string) => {
	const file = join(out, `${slug}.html`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, html);
};

for (const page of pages) {
	const md = page === snapshotPage ? snapshotMarkdown(snapshot(), recentMerges(), meta) : read(page.src);
	write(page.slug, renderPage(page, renderMarkdown(md, page.src, byPath, repoUrl), pages, meta));
}

console.log(`docs: ${pages.length} сторінок у ${relative(root, out)} (${meta.sha.slice(0, 7)})`);

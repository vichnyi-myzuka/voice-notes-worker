import { describe, expect, it } from "vitest";
import { headingId, pageGroup, pageSlug, renderMarkdown, renderNav, resolveRepoPath, rewriteHref, snapshotMarkdown, summarizeWrangler, type Page } from "../build/lib";

const mk = (src: string, title = src): Page => ({ src, slug: pageSlug(src), title, group: pageGroup(src) });
const pages = new Map([mk("docs/agent.md"), mk("README.md"), mk("docs/adr/0001-x.md")].map((p) => [p.src, p]));
const repo = "https://github.com/o/r";

describe("сторінки", () => {
	it("архітектура — головна, решта за шляхом", () => {
		expect(pageSlug("docs/architecture.md")).toBe("index");
		expect(pageSlug("docs/adr/0001-x.md")).toBe("adr/0001-x");
		expect(pageSlug("README.md")).toBe("readme");
	});

	it("заголовок id підтримує кирилицю", () => {
		expect(headingId("Тести, lint і git-хуки")).toBe("тести-lint-і-git-хуки");
	});
});

describe("посилання", () => {
	it("відносні посилання між сторінками стають сторінками сайту", () => {
		expect(rewriteHref("agent.md#a", "docs/notes.md", pages, repo)).toBe("/agent.html#a");
		expect(rewriteHref("../README.md", "docs/notes.md", pages, repo)).toBe("/readme.html");
		expect(rewriteHref("docs/adr/0001-x.md", "README.md", pages, repo)).toBe("/adr/0001-x.html");
	});

	it("файли коду ведуть на GitHub, зовнішні й якорі лишаються", () => {
		expect(rewriteHref("../apps/agent/wrangler.toml", "docs/agent.md", pages, repo)).toBe(`${repo}/blob/main/apps/agent/wrangler.toml`);
		expect(rewriteHref("https://x.dev/a", "README.md", pages, repo)).toBe("https://x.dev/a");
		expect(rewriteHref("#top", "README.md", pages, repo)).toBe("#top");
	});

	it("вихід за корінь не розв'язується", () => {
		expect(resolveRepoPath("README.md", "../x")).toBeNull();
	});
});

describe("рендер", () => {
	it("mermaid-блок, заголовок з id і екранований сирий HTML", () => {
		const html = renderMarkdown("# Привіт\n\n```mermaid\nflowchart LR\n a-->b\n```\n\n<script>alert(1)</script>\n\n[a](agent.md)", "docs/x.md", pages, repo);
		expect(html).toContain('<h1 id="привіт">');
		expect(html).toContain('<pre class="mermaid">flowchart LR');
		expect(html).toContain("a--&gt;b");
		expect(html).not.toContain("<script>alert");
		expect(html).toContain('href="/agent.html"');
	});

	it("навігація групує сторінки й позначає поточну", () => {
		const nav = renderNav([mk("docs/architecture.md", "Архітектура"), mk("docs/adr/0001-x.md", "ADR 1")], "index");
		expect(nav).toContain('<a href="/index.html" aria-current="page">Архітектура</a>');
		expect(nav.indexOf("Архітектура")).toBeLessThan(nav.indexOf("Рішення"));
	});
});

describe("знімок", () => {
	it("wrangler: лише прив'язки, без змінних і коментарів", () => {
		const toml = `name = "w"\n# c\n[vars]\nSECRET_LIKE = "x"\n[[r2_buckets]]\nbinding = "B"\nbucket_name = "b" # c\n[observability]\nenabled = true`;
		expect(summarizeWrangler(toml)).toBe(`  name = "w"\n[[r2_buckets]]\n  binding = "B"\n  bucket_name = "b"\n[observability]`);
	});

	it("markdown знімка містить модулі, прив'язки й мержі", () => {
		const md = snapshotMarkdown([{ name: "apps/a", dirs: [{ dir: "x", files: ["i.ts"] }], bindings: "name = 'a'" }], [{ date: "2026-01-01", title: "PR" }], { sha: "abcdef123", date: "d", repoUrl: repo });
		expect(md).toContain("`abcdef1`");
		expect(md).toContain("- `x/`: `i.ts`");
		expect(md).toContain("```toml");
		expect(md).toContain("2026-01-01: PR");
	});
});

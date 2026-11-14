// Чиста логіка збірки сайту документації: Markdown → HTML, посилання між сторінками, каркас, знімок коду. Без файлової системи.
import { Marked } from "marked";

export interface Page {
	src: string; // шлях у репозиторії, напр. docs/agent.md
	slug: string; // шлях вихідного файлу без .html: index, readme, adr/0001-...
	title: string;
	group: string;
}

// Мапа «шлях у репозиторії → сторінка»; архітектура — головна.
export function pageSlug(src: string): string {
	if (src === "docs/architecture.md") return "index";
	return src.replace(/^docs\//, "").replace(/\.md$/, "").toLowerCase();
}

export function pageGroup(src: string): string {
	if (src === "docs/architecture.md") return "Архітектура";
	if (src.startsWith("docs/adr/")) return "Рішення (ADR)";
	if (src.startsWith("docs/agents/")) return "Довідники для агентів";
	if (src === "README.md" || src === "GLOSSARY.md" || src === "AGENTS.md") return "Проєкт";
	return "Документація";
}

export function firstHeading(md: string, fallback: string): string {
	return /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? fallback;
}

// Ідентифікатор заголовка: літери (зокрема кирилиця), цифри й дефіси.
export function headingId(text: string): string {
	return text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
}

const dirOf = (p: string) => p.split("/").slice(0, -1);

// Відносне посилання з файлу `from` → шлях у репозиторії (без виходу за корінь).
export function resolveRepoPath(from: string, href: string): string | null {
	const parts = [...dirOf(from)];
	for (const seg of href.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join("/");
}

export function rewriteHref(href: string, from: string, pages: Map<string, Page>, repoUrl: string): string {
	if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;
	const [path, hash] = href.split("#");
	const target = resolveRepoPath(from, decodeURIComponent(path ?? ""));
	if (target === null) return href;
	const page = pages.get(target);
	if (page) return `/${page.slug}.html${hash ? `#${hash}` : ""}`;
	return `${repoUrl}/blob/main/${target}`; // код, конфіги тощо: відкриваємо на GitHub
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderMarkdown(md: string, from: string, pages: Map<string, Page>, repoUrl: string): string {
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth }) {
				const inner = this.parser.parseInline(tokens);
				const id = headingId(inner);
				return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const url = rewriteHref(href, from, pages, repoUrl);
				const t = title ? ` title="${escapeHtml(title)}"` : "";
				return `<a href="${escapeHtml(url)}"${t}>${this.parser.parseInline(tokens)}</a>`;
			},
			code({ text, lang }) {
				if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
				return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>\n`;
			},
			// Сирий HTML з документів не пропускаємо: сторінка приватна, але вміст не мусить виконуватись.
			html({ text }) {
				return escapeHtml(text);
			},
		},
	});
	return marked.parse(md, { async: false });
}

export interface Meta {
	sha: string;
	date: string; // ISO
	repoUrl: string;
}

const GROUP_ORDER = ["Архітектура", "Проєкт", "Документація", "Рішення (ADR)", "Довідники для агентів"];

export function renderNav(pages: Page[], current: string): string {
	const groups = new Map<string, Page[]>();
	for (const p of pages) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	const ordered = [...groups.keys()].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
	return ordered
		.map((g) => {
			const items = (groups.get(g) ?? [])
				.map((p) => `<li><a href="/${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ""}>${escapeHtml(p.title)}</a></li>`)
				.join("");
			return `<h4>${escapeHtml(g)}</h4><ul>${items}</ul>`;
		})
		.join("");
}

const CSS = `
:root{--bg:#fff;--fg:#1c2024;--muted:#5f6b76;--line:#e2e6ea;--accent:#2563eb;--code:#f3f5f7}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#98a3ad;--line:#2a3036;--accent:#7aa7ff;--code:#1e2328}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:flex;min-height:100vh}
nav{width:280px;flex:none;padding:24px 20px;border-right:1px solid var(--line);position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{font-weight:700;font-size:18px;margin-bottom:8px}
nav h4{margin:20px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
nav ul{list-style:none;margin:0;padding:0}
nav a{display:block;padding:3px 0;color:var(--fg);text-decoration:none;font-size:14px}
nav a:hover,nav a[aria-current]{color:var(--accent)}
nav a[aria-current]{font-weight:600}
main{flex:1;min-width:0;max-width:960px;padding:32px 40px 64px}
a{color:var(--accent)}
h1,h2,h3{line-height:1.25}
h2{margin-top:2em;padding-top:.4em;border-top:1px solid var(--line)}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.9em}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto;font-size:13px;line-height:1.5}
pre code{background:none;padding:0}
pre.mermaid{background:none;text-align:center;padding:8px 0}
table{border-collapse:collapse;display:block;overflow:auto}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
blockquote{margin:1em 0;padding:0 1em;border-left:3px solid var(--line);color:var(--muted)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media(max-width:800px){body{display:block}nav{width:auto;height:auto;position:static;border-right:0;border-bottom:1px solid var(--line)}main{padding:20px}}
`;

const MERMAID = `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
await mermaid.run({ querySelector: "pre.mermaid" });
</script>`;

export function renderPage(page: Page, body: string, pages: Page[], meta: Meta): string {
	const short = meta.sha.slice(0, 7);
	return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)} · Архітектура бота</title>
<style>${CSS}</style>
</head>
<body>
<nav><div class="brand">Voice notes · архітектура</div>${renderNav(pages, page.slug)}</nav>
<main>
${body}
<footer>Зібрано з <a href="${escapeHtml(meta.repoUrl)}/commit/${escapeHtml(meta.sha)}"><code>${escapeHtml(short)}</code></a> · ${escapeHtml(meta.date)} · <a href="${escapeHtml(meta.repoUrl)}/blob/main/${escapeHtml(page.src)}">джерело сторінки</a></footer>
</main>
${MERMAID}
</body>
</html>
`;
}

// ---- Знімок коду: структура модулів і прив'язки воркерів, зібрані з репозиторію ----

export interface AppSnapshot {
	name: string; // apps/notes
	dirs: { dir: string; files: string[] }[]; // тека відносно src і її файли
	bindings: string; // стислий вміст wrangler.toml
}

export interface Merge {
	date: string;
	title: string;
}

// Лише потрібні ключі wrangler.toml: заголовки таблиць і прив'язки (без змінних, коментарів і довгих значень).
export function summarizeWrangler(toml: string): string {
	const keys = new Set(["name", "binding", "bucket_name", "queue", "class_name", "image", "max_instances", "instance_type", "directory", "new_sqlite_classes"]);
	const out: string[] = [];
	let skipVars = false;
	for (const raw of toml.split("\n")) {
		const line = raw.replace(/\s+#.*$/, "").trimEnd();
		if (!line.trim() || line.trim().startsWith("#")) continue;
		if (/^\s*\[/.test(line)) {
			skipVars = /^\[(env\.\w+\.)?vars\]/.test(line.trim());
			if (!skipVars) out.push(line.trim());
			continue;
		}
		if (skipVars) continue;
		const key = /^\s*([\w-]+)\s*=/.exec(line)?.[1];
		if (key && keys.has(key) && line.length <= 120) out.push(`  ${line.trim()}`);
	}
	return out.join("\n");
}

export function snapshotMarkdown(apps: AppSnapshot[], merges: Merge[], meta: Meta): string {
	const lines = [
		"# Знімок коду",
		"",
		`Згенеровано автоматично з репозиторію при кожній збірці (коміт [\`${meta.sha.slice(0, 7)}\`](${meta.repoUrl}/commit/${meta.sha}), ${meta.date}). Структура модулів і прив'язки Cloudflare тут завжди відповідають \`main\`; пояснення й діаграми дивись на сторінці «Архітектура».`,
		"",
	];
	for (const app of apps) {
		lines.push(`## \`${app.name}\``, "", "Модулі (`src`):", "");
		for (const d of app.dirs) lines.push(`- \`${d.dir || "."}/\`: ${d.files.map((f) => `\`${f}\``).join(", ")}`);
		if (app.bindings) lines.push("", "Прив'язки (`wrangler.toml`):", "", "```toml", app.bindings, "```");
		lines.push("");
	}
	if (merges.length) {
		lines.push("## Останні мержі в main", "");
		for (const m of merges) lines.push(`- ${m.date}: ${m.title}`);
		lines.push("");
	}
	return lines.join("\n");
}

import type { Env } from "./env";

// Назва сайту = перший сегмент шляху; ту саму перевірку робить команда `publish` у контейнері.
export const SITE_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;

const TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	md: "text/plain; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	xml: "application/xml; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	pdf: "application/pdf",
	wasm: "application/wasm",
};

const HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache" };

// Публічний хост віддає чужим людям контент, який пише модель: лише статика, жодних відправок форм і запитів на чужі сервери
// (проти фішингу й витоку), ніяких фреймів, без індексації пошуковиками.
const PUBLIC_HEADERS = {
	"content-security-policy":
		"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
	"x-robots-tag": "noindex, nofollow",
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Шлях запиту → ключ в R2 (`<назва>/<файл>`) або null, якщо шлях небезпечний чи це не сайт.
// Теки (і порожній шлях) віддають index.html; «..», «.», зворотні скісні й керівні символи відхиляються.
export function siteKey(pathname: string): { name: string; key: string } | { redirect: string } | null {
	let path: string;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	// oxlint-disable-next-line no-control-regex -- керівні символи у шляху відхиляємо навмисно
	if (path.includes("\\") || /[\x00-\x1f]/.test(path)) return null;
	const [, name, ...rest] = path.split("/");
	if (!name || !SITE_NAME.test(name)) return null;
	if (rest.length === 0) return { redirect: `/${name}/` }; // відносні посилання на сторінці потребують слеша
	if (rest.some((s, i) => s === ".." || s === "." || (s === "" && i < rest.length - 1))) return null;
	const file = rest.join("/");
	return { name, key: `${name}/${file === "" || file.endsWith("/") ? `${file}index.html` : file}` };
}

// Корінь: список опублікованих сайтів.
async function listing(env: Env): Promise<Response> {
	const { delimitedPrefixes } = await env.SITES.list({ delimiter: "/" });
	const names = delimitedPrefixes.map((p) => p.slice(0, -1)).filter((n) => SITE_NAME.test(n)).sort();
	const items = names.map((n) => `<li><a href="/${n}/">${escapeHtml(n)}</a></li>`).join("");
	const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Сайти агента</title><h1>Сайти агента</h1>${names.length ? `<ul>${items}</ul>` : "<p>Поки порожньо.</p>"}`;
	return new Response(html, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
}

export async function serveSite(req: Request, env: Env): Promise<Response> {
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
	const url = new URL(req.url);
	const isPublic = env.PUBLIC === "1";
	const extra = isPublic ? PUBLIC_HEADERS : {};
	const notFound = () => new Response("not found", { status: 404, headers: extra });
	// Публічний хост списку сайтів не показує: посилання знають лише ті, кому їх надіслали.
	if (url.pathname === "/") return isPublic ? notFound() : listing(env);

	const target = siteKey(url.pathname);
	if (!target) return notFound();
	if ("redirect" in target) return Response.redirect(new URL(target.redirect, url).toString(), 308);

	const object = await env.SITES.get(target.key);
	if (!object) return notFound();
	const ext = target.key.split(".").pop()?.toLowerCase() ?? "";
	const type = TYPES[ext] ?? object.httpMetadata?.contentType ?? "application/octet-stream";
	return new Response(req.method === "HEAD" ? null : object.body, { headers: { ...HEADERS, ...extra, "content-type": type, etag: object.httpEtag } });
}

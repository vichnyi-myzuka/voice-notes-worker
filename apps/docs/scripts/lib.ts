// Чиста логіка генерації даних сайту з репозиторію (без файлової системи).
export interface Module {
	dir: string; // відносно src
	files: string[];
}

export interface AppData {
	name: string; // apps/notes
	kind: "app" | "package";
	modules: Module[];
	bindings: string;
}

export interface Adr {
	file: string;
	title: string;
	decision: string;
}

export interface Doc {
	path: string;
	title: string;
}

export interface Merge {
	date: string;
	title: string;
}

export interface Generated {
	sha: string;
	date: string;
	repoUrl: string;
	apps: AppData[];
	adrs: Adr[];
	docs: Doc[];
	merges: Merge[];
}

export function firstHeading(md: string, fallback: string): string {
	return /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? fallback;
}

// Прибирає розмітку Markdown у короткому тексті (посилання, жирний, код).
export function plain(md: string): string {
	return md
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

// Абзац «**Рішення.** …» з ADR.
export function adrDecision(md: string): string {
	const m = /\*\*Рішення\.\*\*\s*([^\n]+)/.exec(md);
	return m?.[1] ? plain(m[1]) : "";
}

// Лише потрібні ключі wrangler.toml: заголовки таблиць і прив'язки (без змінних, коментарів і довгих значень).
export function summarizeWrangler(toml: string): string {
	const keys = new Set(["name", "binding", "bucket_name", "queue", "class_name", "image", "max_instances", "instance_type", "directory"]);
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

// Заголовок мерж-коміту GitHub лежить у тілі коміту; рядки вигляду `дата<TAB>тіло`.
export function parseMerges(log: string): Merge[] {
	return log
		.split("\n")
		.map((l) => l.split("\t"))
		.filter((p): p is [string, string] => Boolean(p[0] && p[1]))
		.map(([date, title]) => ({ date, title }));
}

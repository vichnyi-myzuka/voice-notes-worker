import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_SITE_DIR, REPORT_SITE_FILES } from "../src/infrastructure/container/computer/report-site";

// Усі файли з payload/report-site/ (без суфікса .tpl), рекурсивно.
const onDisk = (dir: string, prefix = ""): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? onDisk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name.replace(/\.tpl$/, "")}`]));

describe("шаблон сайту-звіту", () => {
	it("кожен файл теки payload/report-site підключено в report-site.ts (і навпаки)", () => {
		const files = onDisk(join(__dirname, "../payload/report-site")).sort();
		expect(REPORT_SITE_FILES.map((f) => f.path.slice(REPORT_SITE_DIR.length + 1)).sort()).toEqual(files);
		expect(files).toContain("src/App.tsx");
	});

	it("файли не порожні й розкладаються з правами 644", () => {
		for (const f of REPORT_SITE_FILES) {
			expect(f.content.length).toBeGreaterThan(10);
			expect(f.mode).toBe("644");
		}
	});
});

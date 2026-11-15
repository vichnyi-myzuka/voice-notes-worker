import { describe, expect, it } from "vitest";
import { byPage, categories, statusLabels } from "../web/src/features";
import { how } from "../web/src/content";

describe("каталог фіч", () => {
	it("id категорій унікальні, у кожній є фічі з назвою, описом і відомим статусом", () => {
		expect(new Set(categories.map((c) => c.id)).size).toBe(categories.length);
		for (const c of categories) {
			expect(c.features.length, c.id).toBeGreaterThan(0);
			for (const f of c.features) {
				expect(f.name, c.id).not.toBe("");
				expect(f.text, f.name).not.toBe("");
				expect(statusLabels[f.status], f.name).toBeDefined();
			}
		}
	});

	it("кожна сторінка з фічами має категорії й опис", () => {
		for (const page of ["notes", "agent", "sites"] as const) {
			expect(byPage(page).length, page).toBeGreaterThan(0);
			expect(how.some((h) => h.page === page), page).toBe(true);
		}
	});
});

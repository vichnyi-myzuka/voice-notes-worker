import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		// Як у Wrangler: *.txt імпортується як рядок (Text module).
		{
			name: "text-modules",
			enforce: "pre", // раніше за вбудовану обробку .txt як asset
			load(id) {
				if (id.endsWith(".txt")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
			},
		},
	],
	test: { include: ["test/**/*.test.ts"] },
});

import { defineConfig } from "vitest/config";

// .md і .sh підключаються як текст, як правило Text у wrangler.toml (див. src/infrastructure/container/payload.ts).
export default defineConfig({
	plugins: [
		{
			name: "text-files",
			transform: (code, id) => (/\.(md|sh)$/.test(id) ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined),
		},
	],
	test: { include: ["test/**/*.test.ts"] },
});

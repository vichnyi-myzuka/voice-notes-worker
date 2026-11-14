import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Каркас — шаблон report-site (Vite + React + Tailwind). base "./": сайт може лежати під шляхом (publish).
export default defineConfig({
	root: "web",
	base: "./",
	plugins: [react(), tailwindcss()],
	build: { outDir: "../dist", emptyOutDir: true },
});

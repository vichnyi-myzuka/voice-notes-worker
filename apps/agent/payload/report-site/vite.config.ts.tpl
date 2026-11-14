import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// base "./": сайт живе під /<назва>/, тому всі шляхи відносні
export default defineConfig({ base: "./", plugins: [react(), tailwindcss()] });

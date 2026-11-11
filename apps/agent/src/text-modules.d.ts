// Файли payload/ підключаються як текст (правило Text у wrangler.toml; у тестах — плагін у vitest.config.ts).
declare module "*.md" {
	const text: string;
	export default text;
}
declare module "*.sh" {
	const text: string;
	export default text;
}

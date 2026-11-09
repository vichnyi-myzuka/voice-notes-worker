// Wrangler за замовчуванням імпортує *.txt як рядок (Text module).
declare module "*.txt" {
	const content: string;
	export default content;
}

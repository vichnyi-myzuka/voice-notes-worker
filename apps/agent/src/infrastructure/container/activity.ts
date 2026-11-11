// Підпис поточної дії агента для поста в чаті: з назви інструмента (session.tool.input.started) і аргументів (session.tool.called).
// Команди bash не показуємо повністю (у них можуть бути токени): лише назву програми.

const MAX = 60;
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

// Шлях без префікса теки сесії: `/workspace/sessions/<тека>/src/a.ts` → `src/a.ts`.
const short = (p: string) => p.replace(/^\/workspace\/(?:sessions\/[^/]+\/|repos\/[^/]+\/[^/]+\/)?/, "");

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function describeActivity(tool: string, input: Record<string, unknown> | undefined): string {
	const i = input ?? {};
	const file = str(i.filePath) ?? str(i.path) ?? str(i.file);
	switch (tool) {
		case "read":
			return file ? `читає ${cut(short(file))}` : "читає файл";
		case "edit":
		case "write":
		case "patch":
		case "multiedit":
			return file ? `редагує ${cut(short(file))}` : "редагує файл";
		case "bash":
		case "shell": {
			const program = str(i.command)?.split("\n")[0].split(/\s+/)[0];
			return program ? `виконує ${cut(program)}` : "виконує команду";
		}
		case "grep":
		case "glob":
		case "list":
			return str(i.pattern) ? `шукає ${cut(str(i.pattern)!)}` : "шукає у файлах";
		case "webfetch":
		case "websearch": {
			const target = str(i.url) ?? str(i.query);
			return target ? `відкриває ${cut(target.replace(/^https?:\/\//, ""))}` : "шукає в інтернеті";
		}
		case "task":
			return "делегує підзадачу";
		default:
			return cut(`інструмент ${tool}`);
	}
}

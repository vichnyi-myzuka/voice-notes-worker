import type { Env } from "../../env";
import { WRITER, mcpConfig, type McpWanted } from "./payload";
import { sessionDir } from "./state";

// Теки сесій у контейнері: клон репозиторію й worktree (session-prep) та конфіг MCP для сесії. Про життя контейнера, чат і записи
// сесій не знає: контейнер має бути вже запущений (Computer.ensureRunning), а виклики йдуть по черзі (Computer.serial).
export class Workspace {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	// Готує теку сесії в контейнері (клон + worktree або порожня тека) і повертає її шлях. exec не успадковує env контейнера,
	// тому токен передаємо явно. Викликається лише всередині serial().
	async prepare(folder: string, repo: string | undefined, mcp: McpWanted = {}): Promise<string> {
		const proc = await this.ctx.container!.exec(["session-prep", folder, ...(repo ? [repo] : [])], {
			cwd: "/workspace",
			env: { HOME: "/root", ...(this.env.GITHUB_TOKEN && { GITHUB_TOKEN: this.env.GITHUB_TOKEN }) },
		});
		const out = await proc.output();
		const stderr = new TextDecoder().decode(out.stderr);
		if (out.exitCode !== 0) throw new Error(`session-prep failed (${out.exitCode}): ${stderr.trim()}`);
		// З решти stderr (шум git і npm) беремо лише рядок секундоміра: з яких кроків складається підготовка теки.
		const timing = stderr.split("\n").find((line) => line.startsWith("timing "));
		if (timing) console.log(`latency session-prep ${folder}: ${timing.slice("timing ".length)}`);
		const dir = new TextDecoder().decode(out.stdout).trim() || sessionDir(folder);
		if (Object.keys(mcp).length) await this.enableMcp(dir, mcp);
		return dir;
	}

	// MCP (Sure, Сільпо, Календар, Cloudflare) лише для цієї сесії: .opencode/opencode.json (і файли токенів Календаря) у її теці (OpenCode підхоплює його сам), а з git він виключений,
	// щоб не потрапив у коміт. Власний .opencode/opencode.json репозиторію не перезаписуємо. Без налаштованих серверів нічого не робить.
	async enableMcp(dir: string, mcp: McpWanted): Promise<void> {
		const files = mcpConfig(this.env, dir, mcp);
		if (!files) return;
		// Файл репозиторію (під git) не чіпаємо; свій, з попереднього запуску, перезаписуємо: у ньому міг застаріти токен Сільпо.
		const script = `git -C "${dir}" ls-files --error-unmatch .opencode/opencode.json >/dev/null 2>&1 && exit 0; node -e '${WRITER}' && { x=$(git -C "${dir}" rev-parse --git-path info/exclude 2>/dev/null) && echo '/.opencode/' >> "$(cd "${dir}" && realpath "$x")"; true; }`;
		const proc = await this.ctx.container!.exec(["sh", "-c", script], { cwd: "/", env: { HOME: "/root", PAYLOAD: JSON.stringify(files) } });
		const out = await proc.output();
		if (out.exitCode !== 0) throw new Error(`mcp setup failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).trim()}`);
	}
}

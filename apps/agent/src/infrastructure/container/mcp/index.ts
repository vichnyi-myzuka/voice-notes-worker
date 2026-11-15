import type { OAuthLogin } from "@voice-notes/oauth";
import { MCP_SERVICES, OAUTH_MCP_NAMES, type McpAccess, type McpFlags, type McpName, type OAuthMcpName } from "../../../domain/agent";
import type { McpEnv } from "../../../env";
import type { Computer } from "../computer";
import type { Workspace } from "../computer";
import { mcpLogins } from "../logins";
import { putMcp } from "../opencode";
import { MCP_PROMPTS, REFRESHABLE_MCP, refreshableMcp, type McpWanted } from "../computer";
import { sessionDir, type Tracked } from "../state";

// Сервіси власника (MCP) для сесій, адаптер порту McpAccess: входи OAuth (Сільпо, Google Calendar, Cloudflare), короткі токени для
// конфігу теки сесії, їх оновлення в живому OpenCode. Запит агента на сервіс і відповідь власника — application/mcp.
export class McpServers implements McpAccess {
	readonly logins: Record<OAuthMcpName, OAuthLogin>;
	// Що вже передано в OpenCode: тека:сервер → конфіг (у пам'яті; після вивантаження один зайвий PUT нешкідливий).
	private readonly pushed = new Map<string, string>();

	constructor(
		storage: DurableObjectStorage,
		private readonly env: McpEnv,
		private readonly computer: Computer,
		private readonly workspace: Workspace,
	) {
		this.logins = mcpLogins(storage, { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET });
	}

	// Токени запитаних сервісів для конфігу теки (без входу токена немає: сервер не підключається). Короткі, тож беремо свіжі щоразу.
	async wanted(flags: McpFlags): Promise<McpWanted> {
		const wanted: McpWanted = { ...(flags.sure && { sure: true }) };
		for (const name of OAUTH_MCP_NAMES) {
			const token = flags[name] ? await this.logins[name].accessToken() : undefined;
			if (token) wanted[name] = token;
		}
		return wanted;
	}

	// Свіжі токени Сільпо й Cloudflare — у запущений OpenCode (PUT замінює сервер і одразу перепідключає його): файл конфігу він
	// після старту не перечитує, тож без цього прострочений токен давав 401 до нової сесії. Збій не фатальний: лише лог.
	async refresh(id: string, tracked: Tracked, directory?: string): Promise<void> {
		if (!REFRESHABLE_MCP.some((name) => tracked[name])) return;
		try {
			const dir = directory ?? sessionDir(tracked.folder ?? id);
			const servers = refreshableMcp(await this.wanted(Object.fromEntries(REFRESHABLE_MCP.map((name) => [name, tracked[name]]))));
			for (const [name, config] of Object.entries(servers)) {
				// Токен живе близько години, а оновлюється за 5 хвилин до кінця: більшість повідомлень лишаються з тим самим, тоді PUT не потрібен.
				const key = `${dir}:${name}`;
				const body = JSON.stringify(config);
				if (this.pushed.get(key) === body) continue;
				await putMcp(this.computer.opencode(), name, dir, config);
				this.pushed.set(key, body);
			}
		} catch (err) {
			console.error(`mcp refresh ${id} failed:`, err);
		}
	}

	configured(name: McpName): boolean {
		return name !== "sure" || !!(this.env.SURE_MCP_URL && this.env.SURE_MCP_TOKEN);
	}

	async loggedIn(name: McpName): Promise<boolean> {
		return !MCP_SERVICES[name].oauth || !!(await this.wanted({ [name]: true }))[name];
	}

	instructions(name: McpName): string {
		return MCP_PROMPTS[name];
	}

	// Запис сервера в конфіг теки сесії; OpenCode підхоплює його наживо, тож сесія й її історія лишаються. Файл він наживо не
	// перечитує, тому сервер вносимо в запущений OpenCode явно (refresh).
	async connect(id: string, tracked: Tracked): Promise<void> {
		const wanted = await this.wanted(tracked);
		await this.computer.ensureRunning();
		const directory = await this.computer.serial(() => this.workspace.prepare(tracked.folder ?? id, tracked.repo, wanted));
		await this.refresh(id, tracked, directory);
	}
}

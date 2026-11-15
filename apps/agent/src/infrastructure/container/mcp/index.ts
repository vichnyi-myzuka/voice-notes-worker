import type { OAuthLogin } from "@voice-notes/oauth";
import { MCP_LABELS, MCP_NAMES, MCP_SERVICES, OAUTH_MCP_NAMES, type McpAnswer, type McpFlags, type McpName, type OAuthMcpName } from "../../../domain/agent";
import type { ChatEnv, McpEnv } from "../../../env";
import { sendMcpQuestion } from "../../chat";
import type { Computer } from "../computer";
import type { Workspace } from "../computer";
import { mcpLogins } from "../logins";
import { putMcp } from "../opencode";
import { MCP_PROMPTS, REFRESHABLE_MCP, refreshableMcp, type McpWanted } from "../computer";
import { sessionDir, type Tracked } from "../state";
import type { SessionStore } from "../state";

// Агент просить MCP командою `request-mcp <сервіс>` (payload/request-mcp.sh): воркер бачить її у виклику bash у потоці подій OpenCode.
const REQUEST = new RegExp(`(?:^|[\\s;&|(])request-mcp\\s+(${MCP_NAMES.join("|")})(?![\\w-])`);

// Сервіс із виклику інструмента bash (input.command) чи undefined, якщо це інша команда.
export function requestedMcp(input: Record<string, unknown> | undefined): McpName | undefined {
	const command = typeof input?.command === "string" ? input.command : "";
	return REQUEST.exec(command)?.[1] as McpName | undefined;
}

// Сервіси власника (MCP) для сесій: входи OAuth (Сільпо, Google Calendar, Cloudflare), короткі токени для конфігу теки сесії, їх
// оновлення в живому OpenCode, запит агента на сервіс посеред роботи (кнопки власникові) і відповідь на нього.
export class Mcp {
	readonly logins: Record<OAuthMcpName, OAuthLogin>;
	// Що вже передано в OpenCode: тека:сервер → конфіг (у пам'яті; після вивантаження один зайвий PUT нешкідливий).
	private readonly pushed = new Map<string, string>();
	// Запити, на які власник ще не відповів («<id сесії>:<сервіс>»): повторний запит агента не дублює кнопки.
	private readonly asked = new Set<string>();

	constructor(
		storage: DurableObjectStorage,
		private readonly env: ChatEnv & McpEnv,
		private readonly store: SessionStore,
		private readonly computer: Computer,
		private readonly workspace: Workspace,
		// Повідомлення агентові від воркера (як уточнення від власника).
		private readonly tell: (id: string, tracked: Tracked, text: string) => Promise<void>,
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

	// Прапорці запису сесії за тим, що справді підключилось (Sure — якщо просили, решта — якщо є токен).
	static flags(wanted: McpWanted): McpFlags {
		return Object.fromEntries(MCP_NAMES.filter((name) => wanted[name]).map((name) => [name, true]));
	}

	// Системна примітка агентові на старті: сервіс просили, а входу немає (чи токен не оновився). Агент скаже про це власнику замість
	// мовчазної відсутності інструментів.
	static missing(asked: McpFlags, wanted: McpWanted): string[] {
		return OAUTH_MCP_NAMES.filter((name) => asked[name] && !wanted[name]).map(
			(name) => `MCP ${MCP_SERVICES[name].title} не підключено, бо власник ще не ввійшов у ${MCP_SERVICES[name].title}. Скажи йому відкрити сторінку /${name}/login на адресі агента (де веб-інтерфейс), ввійти й повторити задачу. Не вигадуй даних із цього сервісу.`,
		);
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

	// Агент просить підключити MCP (команда request-mcp): власнику йдуть кнопки в тему сесії. Підключене вже, невідоме чи без поста в чаті — ігноруємо.
	async request(ocId: string, name: McpName): Promise<void> {
		if (!this.env.BOT_TOKEN) return;
		const found = await this.store.sessionByOc(ocId);
		const post = found?.[1].post;
		if (!found || !post?.chatId || found[1][name]) return;
		const [id] = found;
		if (this.asked.has(`${id}:${name}`)) return;
		this.asked.add(`${id}:${name}`);
		await sendMcpQuestion({ BOT_TOKEN: this.env.BOT_TOKEN }, post.chatId, post.threadId, id, name, `🔌 Агентові потрібен доступ до ${MCP_LABELS[name]}. Підключити до цієї сесії?`);
	}

	// Відповідь власника на запит MCP. Підключення — це запис сервера в конфіг теки сесії: OpenCode підхоплює його наживо (перевірено:
	// сервер з'являється в /api/mcp за кілька секунд без перезапуску), тож сесія й її історія лишаються. Агента про результат
	// повідомляє нове повідомлення в сесію (як уточнення; для підключеного — разом з інструкціями сервісу).
	async answer(id: string, name: McpName, allow: boolean): Promise<McpAnswer> {
		const tracked = await this.store.session(id);
		if (!tracked) throw new Error(`unknown session ${id}`);
		this.asked.delete(`${id}:${name}`);
		if (!allow) {
			await this.tell(id, tracked, `The owner declined to connect the ${name} MCP. Continue without it and do not invent data from it.`);
			return "declined";
		}
		if (name === "sure" && !(this.env.SURE_MCP_URL && this.env.SURE_MCP_TOKEN)) {
			await this.tell(id, tracked, "The sure MCP is not configured on the worker, so it cannot be connected. Continue without it and do not invent data from it.");
			return "unavailable";
		}
		const wanted = await this.wanted({ ...tracked, [name]: true });
		if (MCP_SERVICES[name].oauth && !wanted[name]) {
			await this.tell(id, tracked, `The ${name} MCP is not connected because the owner has not logged in to it yet. Tell them to open /${name}/login on the agent address, log in, and repeat the request. Do not invent data.`);
			return "login";
		}
		await this.computer.ensureRunning();
		const directory = await this.computer.serial(() => this.workspace.prepare(tracked.folder ?? id, tracked.repo, wanted));
		await this.refresh(id, { ...tracked, [name]: true }, directory); // файл OpenCode наживо не перечитує: сервер вносимо явно
		await this.store.saveSession(id, { ...tracked, [name]: true });
		await this.tell(id, tracked, `The owner connected the ${name} MCP: its tools (names start with \`${name}_\`) are available from this step on. Continue the task. Instructions for this service:\n\n${MCP_PROMPTS[name]}`);
		return "connected";
	}
}

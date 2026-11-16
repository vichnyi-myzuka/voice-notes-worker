import { MCP_LABELS, MCP_NAMES, MCP_SERVICES, OAUTH_MCP_NAMES, type McpAccess, type McpAnswer, type McpFlags, type McpName, type Notices, type SessionStore, type Tracked } from "../../domain/agent";

// Запит агента на сервіс власника (MCP) посеред роботи й відповідь власника. Токени, входи, запис конфігу в теку сесії й
// оновлення в живому OpenCode — за портом McpAccess; кнопки в чат — за Notices.
export class Mcp {
	// Запити, на які власник ще не відповів («<id сесії>:<сервіс>»): повторний запит агента не дублює кнопки.
	private readonly asked = new Set<string>();

	constructor(
		private readonly store: SessionStore,
		private readonly access: McpAccess,
		private readonly notices: Notices,
		// Повідомлення агентові від воркера (як уточнення від власника).
		private readonly tell: (id: string, tracked: Tracked, text: string) => Promise<void>,
	) {}

	// Прапорці запису сесії за тим, що справді підключилось (Sure — якщо просили, решта — якщо є токен).
	static flags(wanted: Partial<Record<McpName, unknown>>): McpFlags {
		return Object.fromEntries(MCP_NAMES.filter((name) => wanted[name]).map((name) => [name, true]));
	}

	// Системна примітка агентові на старті: сервіс просили, а входу немає (чи токен не оновився). Агент скаже про це власнику замість
	// мовчазної відсутності інструментів.
	static missing(asked: McpFlags, wanted: Partial<Record<McpName, unknown>>): string[] {
		return OAUTH_MCP_NAMES.filter((name) => asked[name] && !wanted[name]).map(
			(name) => `MCP ${MCP_SERVICES[name].title} не підключено, бо власник ще не ввійшов у ${MCP_SERVICES[name].title}. Скажи йому відкрити сторінку /${name}/login на адресі агента (де веб-інтерфейс), ввійти й повторити задачу. Не вигадуй даних із цього сервісу.`,
		);
	}

	// Агент просить підключити MCP (команда request-mcp): власнику йдуть кнопки в тему сесії. Підключене вже, невідоме чи без поста в чаті — ігноруємо.
	async request(ocId: string, name: McpName): Promise<void> {
		if (!this.notices.enabled) return;
		const found = await this.store.sessionByOc(ocId);
		const post = found?.[1].post;
		if (!found || !post?.chatId || found[1][name]) return;
		const [id] = found;
		if (this.asked.has(`${id}:${name}`)) return;
		this.asked.add(`${id}:${name}`);
		await this.notices.askMcp(id, { chatId: post.chatId, threadId: post.threadId }, name, `🔌 Агентові потрібен доступ до ${MCP_LABELS[name]}. Підключити до цієї сесії?`);
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
		if (!this.access.configured(name)) {
			await this.tell(id, tracked, `The ${name} MCP is not configured on the worker, so it cannot be connected. Continue without it and do not invent data from it.`);
			return "unavailable";
		}
		if (MCP_SERVICES[name].oauth && !(await this.access.loggedIn(name))) {
			await this.tell(id, tracked, `The ${name} MCP is not connected because the owner has not logged in to it yet. Tell them to open /${name}/login on the agent address, log in, and repeat the request. Do not invent data.`);
			return "login";
		}
		const connected: Tracked = { ...tracked, [name]: true };
		console.log(`mcp ${name}: connecting to session ${id}`);
		await this.access.connect(id, connected);
		await this.store.saveSession(id, connected);
		console.log(`mcp ${name}: connected, telling the agent`);
		await this.tell(id, tracked, `The owner connected the ${name} MCP: its tools (names start with \`${name}_\`) are available from this step on. Continue the task. Instructions for this service:\n\n${this.access.instructions(name)}`);
		return "connected";
	}
}

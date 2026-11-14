import type { OAuthLogin } from "@voice-notes/oauth";
import { MCP_LABELS, MCP_NAMES, type McpAnswer, type McpName } from "../../domain/agent";
import type { Env } from "../../env";
import { sendMcpQuestion } from "../chat";
import type { Computer } from "./computer";
import { calendarLogin, cloudflareLogin, silpoLogin } from "./logins";
import { putMcp } from "./opencode";
import { MCP_PROMPTS, refreshableMcp, type McpWanted } from "./payload";
import { sessionDir, type Tracked } from "./state";
import type { SessionStore } from "./store";

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
	readonly silpo: OAuthLogin;
	readonly calendar: OAuthLogin;
	readonly cloudflare: OAuthLogin;
	// Що вже передано в OpenCode: тека:сервер → конфіг (у пам'яті; після вивантаження один зайвий PUT нешкідливий).
	private readonly pushed = new Map<string, string>();
	// Запити, на які власник ще не відповів («<id сесії>:<сервіс>»): повторний запит агента не дублює кнопки.
	private readonly asked = new Set<string>();

	constructor(
		storage: DurableObjectStorage,
		private readonly env: Env,
		private readonly store: SessionStore,
		private readonly computer: Computer,
		// Повідомлення агентові від воркера (як уточнення від власника).
		private readonly tell: (id: string, tracked: Tracked, text: string) => Promise<void>,
	) {
		this.silpo = silpoLogin(storage);
		this.calendar = calendarLogin(storage, { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET });
		this.cloudflare = cloudflareLogin(storage);
	}

	// Токени запитаних сервісів для конфігу теки (без входу токена немає: сервер не підключається). Короткі, тож беремо свіжі щоразу.
	async wanted(flags: Partial<Record<McpName, boolean>>): Promise<McpWanted> {
		return {
			sure: flags.sure,
			silpo: flags.silpo ? (await this.silpo.accessToken())?.access : undefined,
			calendar: flags.calendar ? await this.calendar.accessToken() : undefined,
			cloudflare: flags.cloudflare ? (await this.cloudflare.accessToken())?.access : undefined,
		};
	}

	// Системна примітка агентові на старті: сервіс просили, а входу немає (чи токен не оновився). Агент скаже про це власнику замість
	// мовчазної відсутності інструментів.
	static missing(asked: Partial<Record<McpName, boolean>>, wanted: McpWanted): string[] {
		return [
			asked.silpo && !wanted.silpo && "MCP Сільпо не підключено, бо власник ще не ввійшов у Сільпо. Скажи йому відкрити сторінку /silpo/login на адресі агента (де веб-інтерфейс), ввійти в Сільпо й повторити задачу. Не вигадуй даних про покупки.",
			asked.calendar && !wanted.calendar && "MCP Google Calendar не підключено, бо власник ще не ввійшов у Google. Скажи йому відкрити сторінку /calendar/login на адресі агента (де веб-інтерфейс), увійти й повторити задачу. Не вигадуй подій.",
			asked.cloudflare && !wanted.cloudflare && "MCP Cloudflare не підключено, бо власник ще не ввійшов у Cloudflare. Скажи йому відкрити сторінку /cloudflare/login на адресі агента (де веб-інтерфейс), увійти й повторити задачу. Не вигадуй стану акаунта.",
		].filter((note): note is string => !!note);
	}

	// Свіжі токени Сільпо й Cloudflare — у запущений OpenCode (PUT замінює сервер і одразу перепідключає його): файл конфігу він
	// після старту не перечитує, тож без цього прострочений токен давав 401 до нової сесії. Збій не фатальний: лише лог.
	async refresh(id: string, tracked: Tracked, directory?: string): Promise<void> {
		if (!tracked.silpo && !tracked.cloudflare) return;
		try {
			const dir = directory ?? sessionDir(tracked.folder ?? id);
			const servers = refreshableMcp(await this.wanted({ silpo: tracked.silpo, cloudflare: tracked.cloudflare }));
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
		if (name !== "sure" && !wanted[name]) {
			await this.tell(id, tracked, `The ${name} MCP is not connected because the owner has not logged in to it yet. Tell them to open /${name}/login on the agent address, log in, and repeat the request. Do not invent data.`);
			return "login";
		}
		await this.computer.ensureRunning();
		const directory = await this.computer.serial(() => this.computer.prepare(tracked.folder ?? id, tracked.repo, wanted));
		await this.refresh(id, { ...tracked, [name]: true }, directory); // файл OpenCode наживо не перечитує: сервер вносимо явно
		await this.store.saveSession(id, { ...tracked, [name]: true });
		await this.tell(id, tracked, `The owner connected the ${name} MCP: its tools (names start with \`${name}_\`) are available from this step on. Continue the task. Instructions for this service:\n\n${MCP_PROMPTS[name]}`);
		return "connected";
	}
}

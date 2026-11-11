import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import type { AgentStatus, StartInput } from "../../domain/agent";
import type { Env } from "../../env";

// Сесія агента без контейнера: OpenCode (V2 SDK) працює прямо в Durable Object, база — SQLite самого DO.
// Обмеження профілю workerd: немає файлової системи, shell і git (FileSystem, Pty, Shell — заглушки),
// тож агент може лише розмовляти й користуватися інструментами, які дають плагіни (наприклад, GitHub API).
// Веб-інтерфейсу немає: fetch повертає історію сесії як JSON.
const DIRECTORY = "/workspace";

export class WorkerdSession extends DurableObject<Env> {
	private readonly opencode: Promise<OpenCodeWorkerd.Interface>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Тримаємо один хост на час життя DO; blockConcurrencyWhile не пускає події, поки він не готовий.
		this.opencode = ctx.blockConcurrencyWhile(() => OpenCodeWorkerd.create({ storage: ctx.storage, config: modelConfig(env) }));
	}

	private async sessionId(): Promise<string | undefined> {
		return this.ctx.storage.get<string>("sessionId");
	}

	// Ідемпотентно: повторний виклик не створює другу сесію й не ставить задачу вдруге.
	async start(input: StartInput): Promise<{ sessionId: string }> {
		const existing = await this.sessionId();
		if (existing) return { sessionId: existing };
		const oc = await this.opencode;
		const session = await oc.session.create({ location: { directory: DIRECTORY }, title: input.prompt.slice(0, 80) });
		await this.ctx.storage.put("sessionId", session.id);
		await oc.session.prompt({ sessionID: session.id, text: input.prompt });
		return { sessionId: session.id };
	}

	async followUp(text: string): Promise<void> {
		const sessionID = await this.sessionId();
		if (!sessionID) throw new Error("session is not started");
		await (await this.opencode).session.prompt({ sessionID, text });
	}

	async status(): Promise<AgentStatus> {
		const sessionID = await this.sessionId();
		if (!sessionID) return "stopped";
		const active = await (await this.opencode).session.active();
		return sessionID in active ? "working" : "idle";
	}

	async abort(): Promise<void> {
		const sessionID = await this.sessionId();
		if (sessionID) await (await this.opencode).session.interrupt({ sessionID });
	}

	// Без веб-інтерфейсу: історія сесії як JSON.
	async fetch(): Promise<Response> {
		const sessionID = await this.sessionId();
		if (!sessionID) return new Response("No session", { status: 404 });
		return Response.json(await (await this.opencode).session.context({ sessionID }));
	}
}

// Ключ моделі передаємо конфігом: у workerd немає змінних середовища процесу.
function modelConfig(env: Env) {
	const providers: Record<string, { settings: { apiKey: string } }> = {};
	if (env.ANTHROPIC_API_KEY) providers.anthropic = { settings: { apiKey: env.ANTHROPIC_API_KEY } };
	if (env.OPENAI_API_KEY) providers.openai = { settings: { apiKey: env.OPENAI_API_KEY } };
	return { providers };
}

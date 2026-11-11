import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { AgentStatus, StartInput } from "../../domain/agent";
import { OPENCODE_PORT, basicAuth, connectClaudeAgent, createSession, interrupt, isBusy, isReady, prompt, sessionExists, type ModelRef, type Opencode } from "./opencode";

// Контейнер лишається живим, поки з ним працюють; потім засинає (ліміти й запобіжники — окремий тікет).
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const READY_ATTEMPTS = 150;

// Сесія агента: один Durable Object = один контейнер з OpenCode і одна сесія OpenCode.
export class AgentSession extends DurableObject<Env> {
	private starting: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
		}
	}

	private opencode(): Opencode {
		const port = this.ctx.container!.getTcpPort(OPENCODE_PORT);
		const auth = basicAuth(this.env.OPENCODE_PASSWORD);
		return {
			fetch: (path, init) => {
				const headers = new Headers(init?.headers);
				headers.set("authorization", auth);
				return port.fetch(`http://container${path}`, { ...init, headers });
			},
		};
	}

	// Каталог проєкту в контейнері: клон репозиторію (див. entrypoint.sh) або порожня /workspace.
	private async directory(): Promise<string> {
		return (await this.ctx.storage.get<string>("repo")) ? "/workspace/repo" : "/workspace";
	}

	// Із токеном підписки сесії йдуть через Claude Agent; без нього — модель за замовчуванням OpenCode (ключі з env).
	private model(): ModelRef | undefined {
		return this.env.CLAUDE_CODE_OAUTH_TOKEN ? { providerID: "claude-agent", id: this.env.CLAUDE_MODEL || "sonnet" } : undefined;
	}

	// Стартує контейнер (якщо ще не працює) і чекає, поки OpenCode відповість.
	private ensureRunning(): Promise<void> {
		this.starting ??= this.startAndWait().finally(() => void (this.starting = undefined));
		return this.starting;
	}

	private async startAndWait(): Promise<void> {
		const container = this.ctx.container!;
		const started = !container.running;
		if (started) {
			const repo = await this.ctx.storage.get<string>("repo");
			container.start({
				image: container.images.base,
				instance: "standard-1",
				enableInternet: true, // моделі й git
				env: containerEnv(this.env, repo),
			});
			this.ctx.waitUntil(container.monitor().catch((err: unknown) => console.error("container stopped:", err)));
		}
		await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
			try {
				if (await isReady(this.opencode())) {
					// Диск контейнера свіжий після кожного старту: підключаємо Claude Agent знову.
					if (started && this.env.CLAUDE_CODE_OAUTH_TOKEN) await connectClaudeAgent(this.opencode());
					return;
				}
			} catch {
				// порт ще не слухає
			}
			await scheduler.wait(500);
		}
		throw new Error("OpenCode did not become ready");
	}

	// Ідемпотентно: повторний виклик не створює другу сесію OpenCode.
	async start(input: StartInput): Promise<{ sessionId: string }> {
		if (input.repo) await this.ctx.storage.put("repo", input.repo);
		await this.ensureRunning();
		const existing = await this.ctx.storage.get<string>("sessionId");
		if (existing) return { sessionId: existing };
		const sessionId = await createSession(this.opencode(), input.prompt.slice(0, 80), await this.directory(), this.model());
		await this.ctx.storage.put("sessionId", sessionId);
		await prompt(this.opencode(), sessionId, input.prompt);
		return { sessionId };
	}

	// Уточнення в сесію. Після сну контейнера його диск порожній: якщо сесії OpenCode вже немає, створюємо нову.
	async followUp(text: string): Promise<void> {
		await this.ensureRunning();
		let sessionId = await this.ctx.storage.get<string>("sessionId");
		if (!sessionId || !(await sessionExists(this.opencode(), sessionId))) {
			sessionId = await createSession(this.opencode(), text.slice(0, 80), await this.directory(), this.model());
			await this.ctx.storage.put("sessionId", sessionId);
		}
		await prompt(this.opencode(), sessionId, text);
	}

	// Статус не будить контейнер, що спить.
	async status(): Promise<AgentStatus> {
		const sessionId = await this.ctx.storage.get<string>("sessionId");
		if (!sessionId || !this.ctx.container?.running) return "stopped";
		return (await isBusy(this.opencode(), sessionId)) ? "working" : "idle";
	}

	async abort(): Promise<void> {
		const sessionId = await this.ctx.storage.get<string>("sessionId");
		if (!sessionId || !this.ctx.container?.running) return;
		await interrupt(this.opencode(), sessionId);
	}

	// Веб-інтерфейс OpenCode: запити (разом із SSE) проксуються в контейнер.
	async fetch(request: Request): Promise<Response> {
		await this.ensureRunning();
		const url = new URL(request.url);
		const headers = new Headers(request.headers);
		headers.set("authorization", basicAuth(this.env.OPENCODE_PASSWORD));
		headers.delete("host");
		headers.delete("cookie"); // cookie вибору сесії контейнеру не потрібна
		return this.ctx.container!.getTcpPort(OPENCODE_PORT).fetch(new Request(`http://container${url.pathname}${url.search}`, new Request(request, { headers })));
	}
}

function containerEnv(env: Env, repo: string | undefined): Record<string, string> {
	const vars: Record<string, string | undefined> = {
		OPENCODE_PASSWORD: env.OPENCODE_PASSWORD,
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		GITHUB_TOKEN: env.GITHUB_TOKEN,
		CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
		REPO: repo,
	};
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

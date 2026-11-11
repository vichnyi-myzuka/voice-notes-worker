import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { OPENCODE_PORT, basicAuth, createSession, promptAsync, type Opencode } from "./opencode";

// Контейнер лишається живим, поки з ним працюють; потім засинає (ліміти й запобіжники — окремий тікет).
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const READY_ATTEMPTS = 150;

export type StartInput = { prompt: string; repo?: string };

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
		const auth = basicAuth(this.env.OPENCODE_SERVER_PASSWORD);
		return {
			fetch: (path, init) => {
				const headers = new Headers(init?.headers);
				headers.set("authorization", auth);
				return port.fetch(`http://container${path}`, { ...init, headers });
			},
		};
	}

	// Стартує контейнер (якщо ще не працює) і чекає, поки OpenCode відповість.
	private ensureRunning(): Promise<void> {
		this.starting ??= this.startAndWait().finally(() => void (this.starting = undefined));
		return this.starting;
	}

	private async startAndWait(): Promise<void> {
		const container = this.ctx.container!;
		if (!container.running) {
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
				const res = await this.opencode().fetch("/global/health", { signal: AbortSignal.timeout(1500) });
				await res.body?.cancel();
				if (res.ok) return;
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
		const sessionId = await createSession(this.opencode(), input.prompt.slice(0, 80));
		await this.ctx.storage.put("sessionId", sessionId);
		await promptAsync(this.opencode(), sessionId, input.prompt);
		return { sessionId };
	}

	// Веб-інтерфейс OpenCode: запити (разом із SSE) проксуються в контейнер.
	async fetch(request: Request): Promise<Response> {
		await this.ensureRunning();
		const url = new URL(request.url);
		const headers = new Headers(request.headers);
		headers.set("authorization", basicAuth(this.env.OPENCODE_SERVER_PASSWORD));
		headers.delete("host");
		headers.delete("cookie"); // cookie вибору сесії контейнеру не потрібна
		return this.ctx.container!.getTcpPort(OPENCODE_PORT).fetch(new Request(`http://container${url.pathname}${url.search}`, new Request(request, { headers })));
	}
}

function containerEnv(env: Env, repo: string | undefined): Record<string, string> {
	const vars: Record<string, string | undefined> = {
		OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		GITHUB_TOKEN: env.GITHUB_TOKEN,
		REPO: repo,
	};
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

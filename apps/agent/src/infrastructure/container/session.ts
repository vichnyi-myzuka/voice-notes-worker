import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { AgentStatus, StartInput } from "../../domain/agent";
import { OPENCODE_PORT, basicAuth, connectClaudeAgent, createSession, hasModel, interrupt, isBusy, isReady, prompt, sessionExists, type ModelRef, type Opencode } from "./opencode";

// Контейнер лишається живим, поки з ним працюють; потім засинає (ліміти й запобіжники — окремий тікет).
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const READY_ATTEMPTS = 150;
// Знімок диска робимо не частіше й лише коли була активність; поки контейнер працює, alarm перевіряє це.
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

// Знімок прив'язаний до образу, з якого створений: після зміни образу його відновити не можна.
type SavedSnapshot = { id: string; image: string; at: number };

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
		let restored = false;
		if (started) {
			const saved = await this.ctx.storage.get<SavedSnapshot>("snapshot");
			restored = !!saved && saved.image === container.images.base;
			await this.launch(restored ? saved : undefined);
		}
		await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		try {
			await this.waitReady(started && !restored);
		} catch (err) {
			if (!restored) throw err;
			// Знімок не відновився (наприклад, минув термін зберігання): стартуємо з чистого образу.
			console.error("snapshot restore failed, starting from the image:", err);
			await container.destroy();
			await this.ctx.storage.delete("snapshot");
			await this.launch(undefined);
			await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
			await this.waitReady(true);
		}
	}

	// Запускає контейнер зі знімка диска або з образу.
	private async launch(snapshot: SavedSnapshot | undefined): Promise<void> {
		const container = this.ctx.container!;
		const repo = await this.ctx.storage.get<string>("repo");
		container.start({
			...(snapshot ? { containerSnapshot: { id: snapshot.id } } : { image: container.images.base }),
			instance: "standard-1",
			enableInternet: true, // моделі й git
			env: containerEnv(this.env, repo),
		});
		this.ctx.waitUntil(container.monitor().catch((err: unknown) => console.error("container stopped:", err)));
	}

	// Чекає, поки OpenCode відповість; для чистого диска ще підключає Claude Agent (після відновлення підключення вже в базі).
	private async waitReady(connectProvider: boolean): Promise<void> {
		let connected = false;
		for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
			try {
				if (await isReady(this.opencode())) {
					const model = this.model();
					if (connectProvider && model && !connected) {
						await connectClaudeAgent(this.opencode());
						connected = true;
					}
					// Моделі провайдера з'являються не одразу після підключення: без них сесія впаде з «Model unavailable».
					if (model && !(await hasModel(this.opencode(), model))) throw new Error("model is not available yet");
					return;
				}
			} catch {
				// порт ще не слухає або моделі ще не завантажились
			}
			await scheduler.wait(500);
		}
		throw new Error("OpenCode did not become ready");
	}

	// Позначає активність і, якщо alarm ще не заплановано, планує перевірку знімка.
	private async markActive(): Promise<void> {
		await this.ctx.storage.put("activeAt", Date.now());
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_INTERVAL_MS);
	}

	// Alarm зберігає диск контейнера, коли агент вільний і з минулого знімка щось змінилось. Перепланує себе лише поки
	// є що зберігати: постійний alarm не давав би контейнеру заснути.
	async alarm(): Promise<void> {
		const container = this.ctx.container;
		if (!container?.running) return; // контейнер уже спить: знімати нічого
		const [activeAt = 0, saved, sessionId] = await Promise.all([
			this.ctx.storage.get<number>("activeAt"),
			this.ctx.storage.get<SavedSnapshot>("snapshot"),
			this.ctx.storage.get<string>("sessionId"),
		]);
		if (saved && saved.image === container.images.base && saved.at >= activeAt) return; // нових змін немає
		try {
			if (sessionId && (await isBusy(this.opencode(), sessionId))) throw new Error("agent is busy");
			const startedAt = Date.now();
			const snapshot = await container.snapshotContainer({ name: "session" });
			await this.ctx.storage.put("snapshot", { id: snapshot.id, image: container.images.base, at: startedAt } satisfies SavedSnapshot);
		} catch (err) {
			// Зайнятий агент або тимчасова помилка: повторимо наступного разу.
			console.error("snapshot skipped:", err);
			await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_INTERVAL_MS);
		}
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
		await this.markActive();
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
		await this.markActive();
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
		// Зміни з веб-інтерфейсу (повідомлення, правки) теж треба зберегти; читання й SSE — ні.
		if (!["GET", "HEAD"].includes(request.method)) await this.markActive();
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

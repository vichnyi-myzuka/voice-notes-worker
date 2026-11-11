import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { AgentStatus, SnapshotInfo, StartInput } from "../../domain/agent";
import { OPENCODE_PORT, basicAuth, connectClaudeAgent, createSession, hasModel, interrupt, isAnyBusy, isBusy, isReady, prompt, sessionExists, type ModelRef, type Opencode } from "./opencode";

// Контейнер лишається живим, поки з ним працюють; потім засинає (ліміти й запобіжники — окремий тікет).
const DEFAULT_INACTIVITY_MS = 60 * 60 * 1000;
const READY_ATTEMPTS = 150;
// Знімок диска робимо не частіше й лише коли була активність; поки контейнер працює, alarm перевіряє це.
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

// Знімок прив'язаний до образу, з якого створений: після зміни образу його відновити не можна.
type SavedSnapshot = { id: string; image: string; at: number };

// Сесія агента в спільному контейнері: id сесії (наш ключ ідемпотентності) → сесія OpenCode і репозиторій.
type Tracked = { ocId: string; repo?: string };

const sessionKey = (id: string) => `session:${id}`;
const sessionDir = (id: string) => `/workspace/sessions/${id}`;

// Спільний комп'ютер агента: один Durable Object (ім'я `main`) володіє єдиним контейнером з OpenCode, а сесії агентів
// (кожна в своїй теці, для репозиторію в окремому git worktree) живуть усередині нього. Клас називається AgentSession
// історично: перейменування потребувало б міграції Durable Object.
export class AgentSession extends DurableObject<Env> {
	private starting: Promise<void> | undefined;
	// Підготовка тек і створення сесій виконуються по черзі (serial): паралельні `git clone` одного репозиторію псують один одного.
	private queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(this.inactivityMs()));
		}
	}

	// Тривалості з необов'язкових змінних воркера (для коротких перевірок); некоректні значення ігноруються.
	private inactivityMs(): number {
		return positiveInt(this.env.AGENT_INACTIVITY_MS) ?? DEFAULT_INACTIVITY_MS;
	}

	private snapshotIntervalMs(): number {
		return positiveInt(this.env.AGENT_SNAPSHOT_INTERVAL_MS) ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
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
		await container.setInactivityTimeout(this.inactivityMs());
		try {
			await this.waitReady(started && !restored);
		} catch (err) {
			if (!restored) throw err;
			// Знімок не відновився (наприклад, минув термін зберігання): стартуємо з чистого образу.
			console.error("snapshot restore failed, starting from the image:", err);
			await container.destroy();
			await this.ctx.storage.delete("snapshot");
			await this.launch(undefined);
			await container.setInactivityTimeout(this.inactivityMs());
			await this.waitReady(true);
		}
	}

	// Запускає контейнер зі знімка диска або з образу.
	private async launch(snapshot: SavedSnapshot | undefined): Promise<void> {
		const container = this.ctx.container!;
		console.log(snapshot ? `container start from snapshot ${snapshot.id}` : "container start from image");
		container.start({
			...(snapshot ? { containerSnapshot: { id: snapshot.id } } : { image: container.images.base }),
			instance: "standard-1",
			enableInternet: true, // моделі й git
			env: containerEnv(this.env),
		});
		// monitor() не викликаємо: очікуваний promise тримає Durable Object в пам'яті до 15 хв, і таймаут простою не стартує.
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
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.snapshotIntervalMs());
	}

	// Alarm зберігає диск контейнера, коли агенти вільні і з минулого знімка щось змінилось. Перепланує себе лише поки
	// є що зберігати: постійний alarm не давав би контейнеру заснути.
	async alarm(): Promise<void> {
		const container = this.ctx.container;
		if (!container?.running) return; // контейнер уже спить: знімати нічого
		const [activeAt = 0, saved] = await Promise.all([this.ctx.storage.get<number>("activeAt"), this.ctx.storage.get<SavedSnapshot>("snapshot")]);
		if (saved && saved.image === container.images.base && saved.at >= activeAt) return; // нових змін немає
		try {
			if (await isAnyBusy(this.opencode())) throw new Error("an agent is busy");
			await this.saveSnapshot();
		} catch (err) {
			// Зайнятий агент або тимчасова помилка: повторимо наступного разу.
			console.error("snapshot skipped:", err);
			await this.ctx.storage.setAlarm(Date.now() + this.snapshotIntervalMs());
		}
	}

	private async saveSnapshot(): Promise<SnapshotInfo> {
		const container = this.ctx.container!;
		const startedAt = Date.now();
		const snapshot = await container.snapshotContainer({ name: "computer" });
		await this.ctx.storage.put("snapshot", { id: snapshot.id, image: container.images.base, at: startedAt } satisfies SavedSnapshot);
		const info = { id: snapshot.id, bytes: snapshot.size, ms: Date.now() - startedAt };
		console.log(`snapshot saved: ${info.id}, ${info.bytes} bytes, ${info.ms} ms`);
		return info;
	}

	// Ручний знімок: зміни поза сесіями агента (наприклад, через SSH) alarm не бачить. Контейнер, що спить, не будимо.
	async snapshot(): Promise<SnapshotInfo> {
		if (!this.ctx.container?.running) throw new Error("container is not running");
		if (await isAnyBusy(this.opencode())) throw new Error("an agent is busy");
		return this.saveSnapshot();
	}

	// Готує теку сесії в контейнері (клон + worktree або порожня тека) і повертає її шлях. exec не успадковує env контейнера,
	// тому токен передаємо явно. Викликається лише всередині serial().
	private async prepare(id: string, repo: string | undefined): Promise<string> {
		const proc = await this.ctx.container!.exec(["session-prep", id, ...(repo ? [repo] : [])], {
			cwd: "/workspace",
			env: { HOME: "/root", ...(this.env.GITHUB_TOKEN && { GITHUB_TOKEN: this.env.GITHUB_TOKEN }) },
		});
		const out = await proc.output();
		if (out.exitCode !== 0) throw new Error(`session-prep failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).trim()}`);
		return new TextDecoder().decode(out.stdout).trim() || sessionDir(id);
	}

	// Ідемпотентно за id: повторний виклик не створює другу сесію OpenCode й не готує теку вдруге.
	async start(id: string, input: StartInput): Promise<{ sessionId: string }> {
		await this.ensureRunning();
		const existing = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (existing) return { sessionId: existing.ocId };
		return this.serial(async () => {
			const again = await this.ctx.storage.get<Tracked>(sessionKey(id));
			if (again) return { sessionId: again.ocId };
			const directory = await this.prepare(id, input.repo);
			const ocId = await createSession(this.opencode(), input.prompt.slice(0, 80), directory, this.model());
			await this.ctx.storage.put(sessionKey(id), { ocId, repo: input.repo } satisfies Tracked);
			await prompt(this.opencode(), ocId, input.prompt);
			await this.markActive();
			return { sessionId: ocId };
		});
	}

	// Критичні секції по черзі: перевірка «ще немає» й запис мають бути атомарними для одного id, а клони — не паралельними.
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {});
		return result;
	}

	// Уточнення в сесію. Якщо сесії OpenCode вже немає (диск не відновився зі знімка), готуємо теку заново й створюємо нову.
	async followUp(id: string, text: string): Promise<void> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked) throw new Error(`unknown session ${id}`);
		await this.ensureRunning();
		let ocId = tracked.ocId;
		if (!(await sessionExists(this.opencode(), ocId))) {
			ocId = await this.serial(async () => {
				const directory = await this.prepare(id, tracked.repo);
				return createSession(this.opencode(), text.slice(0, 80), directory, this.model());
			});
			await this.ctx.storage.put(sessionKey(id), { ...tracked, ocId } satisfies Tracked);
		}
		await prompt(this.opencode(), ocId, text);
		await this.markActive();
	}

	// Id сесії OpenCode для прямого посилання (контейнер не будимо).
	async link(id: string): Promise<string | undefined> {
		return (await this.ctx.storage.get<Tracked>(sessionKey(id)))?.ocId;
	}

	// Статус не будить контейнер, що спить.
	async status(id: string): Promise<AgentStatus> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked || !this.ctx.container?.running) return "stopped";
		return (await isBusy(this.opencode(), tracked.ocId)) ? "working" : "idle";
	}

	async abort(id: string): Promise<void> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked || !this.ctx.container?.running) return;
		await interrupt(this.opencode(), tracked.ocId);
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
		headers.delete("cookie"); // cookie Access контейнеру не потрібні
		return this.ctx.container!.getTcpPort(OPENCODE_PORT).fetch(new Request(`http://container${url.pathname}${url.search}`, new Request(request, { headers })));
	}
}

function positiveInt(value: string | undefined): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function containerEnv(env: Env): Record<string, string> {
	const vars: Record<string, string | undefined> = {
		OPENCODE_PASSWORD: env.OPENCODE_PASSWORD,
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		GITHUB_TOKEN: env.GITHUB_TOKEN,
		CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
	};
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

import type { ComputerInfo, ConnectionsInfo, SnapshotInfo } from "../../domain/agent";
import type { Env } from "../../env";
import { stopwatch } from "../../timing";
import { parseConnections } from "./connections";
import { FORM_HOLD_MS, READY_ATTEMPTS, containerEnv, idleStopMs, inactivityMs, snapshotIntervalMs } from "./config";
import { IMAGE_MAX_BYTES } from "./images";
import { OPENCODE_PORT, basicAuth, connectClaudeAgent, hasModel, isAnyBusy, isReady, type ModelRef, type Opencode } from "./opencode";
import { PAYLOAD, PAYLOAD_HASH, WRITER, mcpConfig, type McpWanted } from "./payload";
import { sessionDir, type SavedSnapshot } from "./state";

// Спільний комп'ютер агента: єдиний контейнер з OpenCode. Тут його життєвий цикл (старт зі знімка чи образу, очікування
// готовності, розкладання payload, знімки диска, скидання) і доступ до OpenCode. Про сесії, пости й чат модуль нічого не знає.
export class Computer {
	private starting: Promise<void> | undefined;
	// Підготовка тек і створення сесій виконуються по черзі (serial): паралельні `git clone` одного репозиторію псують один одного.
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	get running(): boolean {
		return !!this.ctx.container?.running;
	}

	// Після пробудження Durable Object нову тривалість простою треба передати вже працюючому контейнеру.
	applyInactivityTimeout(): void {
		const container = this.ctx.container;
		if (container?.running) void this.ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(inactivityMs(this.env)));
	}

	opencode(): Opencode {
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
	// requested: «opus» (Claude Agent) або «провайдер/модель»; без нього — CLAUDE_MODEL/sonnet.
	model(requested?: string): ModelRef | undefined {
		const [providerID, ...rest] = requested?.split("/") ?? [];
		if (requested && rest.length) return { providerID, id: rest.join("/") };
		return this.env.CLAUDE_CODE_OAUTH_TOKEN ? { providerID: "claude-agent", id: requested || this.env.CLAUDE_MODEL || "sonnet" } : undefined;
	}

	// Стартує контейнер (якщо ще не працює) і чекає, поки OpenCode відповість.
	ensureRunning(): Promise<void> {
		this.starting ??= this.startAndWait().finally(() => void (this.starting = undefined));
		return this.starting;
	}

	// Критичні секції по черзі: перевірка «ще немає» й запис мають бути атомарними для одного id, а клони — не паралельними.
	serial<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {});
		return result;
	}

	// destroy() інколи кидає виняток, хоч контейнер зупиняється: ігноруємо його й чекаємо, поки running стане false.
	private async destroyContainer(): Promise<void> {
		const container = this.ctx.container!;
		await container.destroy().catch((err) => console.error("container destroy:", err));
		for (let i = 0; container.running && i < 40; i++) await scheduler.wait(500);
	}

	private async startAndWait(): Promise<void> {
		const container = this.ctx.container!;
		const started = !container.running;
		let restored = false;
		const sw = stopwatch("container");
		if (started) {
			const saved = await this.ctx.storage.get<SavedSnapshot>("snapshot");
			// Знімок відновлюємо завжди, навіть якщо образ відтоді змінився: він сам визначає файлову систему (старий образ піднімається
			// з усією історією). Новий образ застосовується лише командою /update.
			restored = !!saved;
			await this.launch(restored ? saved : undefined);
		}
		sw.mark("launch");
		await container.setInactivityTimeout(inactivityMs(this.env));
		try {
			await this.waitReady(started && !restored);
		} catch (err) {
			if (!restored) throw err;
			// Знімок не відновився (наприклад, минув термін зберігання): стартуємо з чистого образу.
			console.error("snapshot restore failed, starting from the image:", err);
			await this.destroyContainer();
			await this.ctx.storage.delete("snapshot");
			await this.launch(undefined);
			await container.setInactivityTimeout(inactivityMs(this.env));
			await this.waitReady(true);
		}
		sw.mark("ready");
		await this.syncPayload(started);
		sw.mark("payload");
		// Лише справжні холодні старти: для вже працюючого контейнера це рядок про кожен виклик, без користі.
		if (started) {
			sw.log({ source: restored ? "snapshot" : "image" });
			await this.markUsed(); // і лише відкрита вкладка після старту теж не триматиме контейнер довше за AGENT_IDLE_STOP_MS
		}
	}

	// Розкладає в контейнер файли з payload/ (інструкції агента, publish, session-prep, git-хук): при кожному старті (знімок міг
	// бути зроблений до останнього деплою) і для працюючого контейнера, якщо вміст змінився. Образ при цьому не чіпається.
	private async syncPayload(force: boolean): Promise<void> {
		if (!force && (await this.ctx.storage.get<string>("payloadHash")) === PAYLOAD_HASH) return;
		const proc = await this.ctx.container!.exec(["node", "-e", WRITER], { cwd: "/", env: { HOME: "/root", PAYLOAD: JSON.stringify(PAYLOAD) } });
		const out = await proc.output();
		if (out.exitCode !== 0) throw new Error(`payload sync failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).trim()}`);
		await this.ctx.storage.put("payloadHash", PAYLOAD_HASH);
	}

	// Запускає контейнер зі знімка диска або з образу.
	private async launch(snapshot: SavedSnapshot | undefined): Promise<void> {
		const container = this.ctx.container!;
		console.log(snapshot ? `container start from snapshot ${snapshot.id}` : "container start from image");
		await this.ctx.storage.put("launchedImage", snapshot ? snapshot.image : container.images.base); // з якого образу контейнер насправді
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
	async markActive(): Promise<void> {
		await this.ctx.storage.put("activeAt", Date.now());
		await this.markUsed();
	}

	// Позначає, що контейнером користувались (старт, робота агента), але диск не змінився; лічильник для зупинки після простою.
	// Читання з веб-інтерфейсу сюди не потрапляє: відкрита вкладка не має тримати контейнер.
	async markUsed(): Promise<void> {
		await this.ctx.storage.put("usedAt", Date.now());
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + snapshotIntervalMs(this.env));
	}

	// Alarm зберігає диск контейнера, коли агенти вільні і з минулого знімка щось змінилось, а після AGENT_IDLE_STOP_MS
	// без роботи зупиняє контейнер. Перепланує себе, лише поки контейнер працює.
	// formAt: коли поставлено останнє питання, що чекає відповіді (0, якщо немає).
	async settle(formAt = 0): Promise<void> {
		if (!this.running) return; // контейнер уже спить
		const [activeAt = 0, usedAt = 0, saved] = await Promise.all([
			this.ctx.storage.get<number>("activeAt"),
			this.ctx.storage.get<number>("usedAt"),
			this.ctx.storage.get<SavedSnapshot>("snapshot"),
		]);
		try {
			if (!saved || saved.at < activeAt) {
				if (await isAnyBusy(this.opencode())) throw new Error("an agent is busy");
				await this.saveSnapshot();
			}
		} catch (err) {
			// Зайнятий агент або тимчасова помилка: повторимо наступного разу.
			console.error("snapshot skipped:", err);
			await this.ctx.storage.setAlarm(Date.now() + snapshotIntervalMs(this.env));
			return;
		}
		const stopAt = Math.max(Math.max(activeAt, usedAt) + idleStopMs(this.env), formAt ? formAt + FORM_HOLD_MS : 0);
		if (Date.now() < stopAt) return void (await this.ctx.storage.setAlarm(stopAt));
		// Знімок свіжий, агенти вільні: диск збережено, тож контейнер можна зупинити.
		if (await isAnyBusy(this.opencode()).catch(() => true)) return void (await this.ctx.storage.setAlarm(Date.now() + snapshotIntervalMs(this.env)));
		console.log("container stopped: idle");
		await this.destroyContainer();
	}

	private async saveSnapshot(): Promise<SnapshotInfo> {
		const container = this.ctx.container!;
		const startedAt = Date.now();
		const snapshot = await container.snapshotContainer({ name: "computer" });
		await this.ctx.storage.put("snapshot", { id: snapshot.id, image: (await this.ctx.storage.get<string>("launchedImage")) ?? container.images.base, at: startedAt } satisfies SavedSnapshot);
		const info = { id: snapshot.id, bytes: snapshot.size, ms: Date.now() - startedAt };
		console.log(`snapshot saved: ${info.id}, ${info.bytes} bytes, ${info.ms} ms`);
		return info;
	}

	// Ручний знімок: зміни поза сесіями агента (наприклад, через SSH) alarm не бачить. Контейнер, що спить, не будимо.
	async snapshot(): Promise<SnapshotInfo> {
		if (!this.running) throw new Error("container is not running");
		if (await isAnyBusy(this.opencode())) throw new Error("an agent is busy");
		return this.saveSnapshot();
	}

	// Після деплою старий контейнер може ще працювати й зробити знімок старої файлової системи під новим образом;
	// це єдиний спосіб його позбутися без SSH: знімок видаляється, контейнер зупиняється.
	async reset(unlessBusy = false): Promise<boolean> {
		if (unlessBusy && this.running && (await isAnyBusy(this.opencode()).catch(() => true))) return false;
		await this.ctx.storage.delete("snapshot");
		if (this.running) await this.destroyContainer();
		return true;
	}

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
		if (mcp.sure || mcp.silpo || mcp.calendar || mcp.cloudflare) await this.enableMcp(dir, mcp);
		return dir;
	}

	// MCP (Sure, Сільпо, Календар, Cloudflare) лише для цієї сесії: .opencode/opencode.json (і файли токенів Календаря) у її теці (OpenCode підхоплює його сам), а з git він виключений,
	// щоб не потрапив у коміт. Власний .opencode/opencode.json репозиторію не перезаписуємо. Без налаштованих серверів нічого не робить.
	private async enableMcp(dir: string, mcp: McpWanted): Promise<void> {
		const files = mcpConfig(this.env, dir, mcp);
		if (!files) return;
		// Файл репозиторію (під git) не чіпаємо; свій, з попереднього запуску, перезаписуємо: у ньому міг застаріти токен Сільпо.
		const script = `git -C "${dir}" ls-files --error-unmatch .opencode/opencode.json >/dev/null 2>&1 && exit 0; node -e '${WRITER}' && { x=$(git -C "${dir}" rev-parse --git-path info/exclude 2>/dev/null) && echo '/.opencode/' >> "$(cd "${dir}" && realpath "$x")"; true; }`;
		const proc = await this.ctx.container!.exec(["sh", "-c", script], { cwd: "/", env: { HOME: "/root", PAYLOAD: JSON.stringify(files) } });
		const out = await proc.output();
		if (out.exitCode !== 0) throw new Error(`mcp setup failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).trim()}`);
	}

	// Виконує у теці /workspace команду з env для публікації сайтів (exec не успадковує env контейнера). Повертає код і stderr.
	async run(cmd: string[], env: Record<string, string>): Promise<{ exitCode: number; stderr: string }> {
		const proc = await this.ctx.container!.exec(cmd, { cwd: "/workspace", env: { HOME: "/root", ...env } });
		const out = await proc.output();
		return { exitCode: out.exitCode, stderr: new TextDecoder().decode(out.stderr).trim() };
	}

	// Читає зображення з контейнера для відправки в чат: лише png/jpg/gif/webp із /workspace чи /tmp і до IMAGE_MAX_BYTES; інше — undefined.
	async readImage(path: string): Promise<Uint8Array | undefined> {
		const script = `f=$(realpath -e "$1") || exit 3; case "$f" in /workspace/*|/tmp/*) ;; *) exit 3;; esac; case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.webp) ;; *) exit 3;; esac; [ -f "$f" ] && [ "$(stat -c %s "$f")" -le ${IMAGE_MAX_BYTES} ] || exit 4; cat "$f"`;
		const proc = await this.ctx.container!.exec(["sh", "-c", script, "sh", path], { cwd: "/workspace", env: { HOME: "/root" } });
		const out = await proc.output();
		return out.exitCode === 0 ? new Uint8Array(out.stdout as ArrayBufferLike) : undefined;
	}

	// Стан для діагностики: чому контейнер не засинає, коли був знімок. streams додає той, хто веде потоки.
	async info(streams: ComputerInfo["streams"]): Promise<ComputerInfo> {
		const [activeAt, alarmAt, snapshot] = await Promise.all([
			this.ctx.storage.get<number>("activeAt"),
			this.ctx.storage.getAlarm(),
			this.ctx.storage.get<SavedSnapshot>("snapshot"),
		]);
		return { running: this.running, activeAt: activeAt ?? null, alarmAt, snapshot: snapshot ? { id: snapshot.id, at: snapshot.at } : null, streams };
	}

	// Скільки SSH-з'єднань відкрито (за /proc/net/tcp). Сплячий контейнер не будимо; але exec продовжує життя працюючого.
	async connections(detail: boolean): Promise<ConnectionsInfo> {
		if (!this.ctx.container?.running) return { running: false };
		if (!detail) return { running: true }; // exec продовжує життя контейнера, тож без detail його не викликаємо
		const proc = await this.ctx.container.exec(["cat", "/proc/net/tcp", "/proc/net/tcp6"]);
		const out = await proc.output();
		if (out.exitCode !== 0) throw new Error(`cannot read /proc/net/tcp (${out.exitCode})`);
		return { running: true, ...parseConnections(new TextDecoder().decode(out.stdout), OPENCODE_PORT) };
	}
}

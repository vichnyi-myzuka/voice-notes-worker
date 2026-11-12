import { tg, workersLlm } from "@voice-notes/core";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { AgentStatus, ComputerInfo, ConnectionsInfo, RemovedSession, SessionReport, SnapshotInfo, StartInput, WatchTarget } from "../../domain/agent";
import { editChat, sendChat, type Answers } from "../chat";
import { parseConnections } from "./connections";
import { CLEANUP } from "./cleanup";
import { PAYLOAD, PAYLOAD_HASH, WRITER } from "./payload";
import { describeActivity, describeForm, formChoices, type Choice } from "./activity";
import { describeCall, narrate, remember } from "./narrate";
import { OPENCODE_PORT, activeSessions, basicAuth, connectClaudeAgent, createSession, deleteSession, getSession, hasModel, interrupt, lastAssistant, totalTokens, isAnyBusy, isBusy, isReady, prompt, readEvents, type OpencodeEvent, type OpencodeForm, replyForm, sessionExists, type ModelRef, type Opencode } from "./opencode";

// Контейнер лишається живим, поки з ним працюють; потім засинає (ліміти й запобіжники — окремий тікет).
const DEFAULT_INACTIVITY_MS = 60 * 60 * 1000;
const READY_ATTEMPTS = 150;
// Потік подій (SSE) тримає Durable Object, а з ним і контейнер, активним: забута вкладка не давала б йому заснути. Тому потік
// живе не довше цього часу; жива вкладка перепідключиться сама.
const STREAM_MAX_MS = 10 * 60 * 1000;
// Знімок диска робимо не частіше й лише коли була активність; поки контейнер працює, alarm перевіряє це.
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

// Поки сесія працює чи за нею стежать, alarm спрацьовує частіше: підсумок у чаті й ліміти витрат.
const WATCH_INTERVAL_MS = 15 * 1000;
// Сесія, що не повернулась у вільний стан за цей час, перестає відстежуватись (контейнер міг загинути).
const WATCH_MAX_MS = 2 * 60 * 60 * 1000;
// Запобіжники за замовчуванням: вартість однієї сесії (USD) і токени (вхід + вихід + reasoning, без кешу).
const DEFAULT_MAX_COST_USD = 5;
const DEFAULT_MAX_TOKENS = 3_000_000;
const WORKING = "⏳ Працює";
// Прийняті завдання (begin/resume) виконує alarm: холодний старт і клон довші за життя запиту вебхука. Збій повторюється,
// потім показується в пості.
const JOB_ATTEMPTS = 6;
const JOB_RETRY_MS = 15 * 1000;
type Job = { id: string; target: WatchTarget; attempts: number } & ({ input: StartInput } | { text: string });
const jobKey = (id: string) => `job:${id}`;
// Питання агента, на яке можна відповісти кнопкою: форма й варіанти (callback_data несе лише номер варіанта).
type PendingForm = { formId: string; ocId: string; key: string; choices: Choice[]; multiple?: boolean; selected: number[]; text: string };
const formKey = (id: string) => `form:${id}`;
const PROGRESS_INTERVAL_MS = 4000; // не частіше: ліміти Telegram на редагування одного повідомлення
const HEADER_FINAL_MAX = 400; // шапка поста разом із підсумком (підсумок до SUMMARY_MAX) має вміститись у 4096
const SUMMARY_MAX = 3000; // підсумок у чат: решта обрізається (ліміт повідомлення Telegram — 4096)

// За сесією стежать, щоб повідомити в чат про завершення. seenBusy: чи бачили ми її працюючою (щойно запущена сесія ще може
// не з'явитись серед активних, тому без цього «вільна» означало б «ще не почала»).
type Watch = WatchTarget & { ocId: string; since: number; seenBusy: boolean };

// Знімок прив'язаний до образу, з якого створений: після зміни образу його відновити не можна.
type SavedSnapshot = { id: string; image: string; at: number };

// Сесія агента в спільному контейнері: id сесії (наш ключ ідемпотентності) → сесія OpenCode і репозиторій.
// folder: назва теки (і гілки agent/<folder>); у старих записів немає, тоді це сам id.
// post: пост сесії в чаті, який агент оновлює на місці (стан, підсумок).
type Tracked = { ocId: string; repo?: string; folder?: string; post?: { postId: number; header: string; chatId?: number; url?: string } };

const sessionKey = (id: string) => `session:${id}`;
const watchKey = (id: string) => `watch:${id}`;
const sessionDir = (folder: string) => `/workspace/sessions/${folder}`;
// Тека й гілка за змістом задачі: `<назва>-<останній сегмент id>` (номер повідомлення робить її унікальною); без назви — id.
const folderFor = (id: string, name?: string) => (name ? `${name}-${id.split("-").at(-1)}` : id);

// Спільний комп'ютер агента: один Durable Object (ім'я `main`) володіє єдиним контейнером з OpenCode, а сесії агентів
// (кожна в своїй теці, для репозиторію в окремому git worktree) живуть усередині нього. Клас називається AgentSession
// історично: перейменування потребувало б міграції Durable Object.
export class AgentSession extends DurableObject<Env> {
	private starting: Promise<void> | undefined;
	// Підготовка тек і створення сесій виконуються по черзі (serial): паралельні `git clone` одного репозиторію псують один одного.
	private queue: Promise<unknown> = Promise.resolve();
	// Відкриті зараз SSE-потоки (лише для діагностики).
	private streams = new Map<number, { path: string; openedAt: number }>();
	private streamSeq = 0;
	// Підписка на події OpenCode, поки за якоюсь сесією стежать (див. listen).
	private events: AbortController | undefined;
	// Прогрес у пості: назви інструментів за id виклику, час останнього оновлення поста сесії й черга правок поста
	// (запізніла проміжна правка не має затирати підсумок: finishWatch чекає на чергу).
	private toolNames = new Map<string, string>();
	private lastProgress = new Map<string, number>();
	// Останні дії агента (для маленької моделі, що описує поточну дію) і її попередній опис — за id сесії OpenCode.
	private recent = new Map<string, string[]>();
	private narration = new Map<string, string>();
	private postQueue: Promise<unknown> = Promise.resolve();

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
		if (started) {
			const saved = await this.ctx.storage.get<SavedSnapshot>("snapshot");
			// Знімок відновлюємо завжди, навіть якщо образ відтоді змінився: він сам визначає файлову систему (старий образ піднімається
			// з усією історією). Новий образ застосовується лише командою /update.
			restored = !!saved;
			await this.launch(restored ? saved : undefined);
		}
		await container.setInactivityTimeout(this.inactivityMs());
		try {
			await this.waitReady(started && !restored);
		} catch (err) {
			if (!restored) throw err;
			// Знімок не відновився (наприклад, минув термін зберігання): стартуємо з чистого образу.
			console.error("snapshot restore failed, starting from the image:", err);
			await this.destroyContainer();
			await this.ctx.storage.delete("snapshot");
			await this.launch(undefined);
			await container.setInactivityTimeout(this.inactivityMs());
			await this.waitReady(true);
		}
		await this.syncPayload(started);
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
	private async markActive(): Promise<void> {
		await this.ctx.storage.put("activeAt", Date.now());
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.snapshotIntervalMs());
	}

	// Alarm зберігає диск контейнера, коли агенти вільні і з минулого знімка щось змінилось. Перепланує себе лише поки
	// є що зберігати: постійний alarm не давав би контейнеру заснути.
	async alarm(): Promise<void> {
		const container = this.ctx.container;
		if (await this.runJobs()) return void (await this.ctx.storage.setAlarm(Date.now() + JOB_RETRY_MS));
		// Поки хтось працює чи за кимось стежать, опитуємо часто (підсумки, ліміти) й знімок відкладаємо.
		if (await this.tick()) return void (await this.ctx.storage.setAlarm(Date.now() + WATCH_INTERVAL_MS));
		if (!container?.running) return; // контейнер уже спить: знімати нічого
		const [activeAt = 0, saved] = await Promise.all([this.ctx.storage.get<number>("activeAt"), this.ctx.storage.get<SavedSnapshot>("snapshot")]);
		if (saved && saved.at >= activeAt) return; // нових змін немає
		try {
			if (await isAnyBusy(this.opencode())) throw new Error("an agent is busy");
			await this.saveSnapshot();
		} catch (err) {
			// Зайнятий агент або тимчасова помилка: повторимо наступного разу.
			console.error("snapshot skipped:", err);
			await this.ctx.storage.setAlarm(Date.now() + this.snapshotIntervalMs());
		}
	}

	// Один оберт опитування: зупиняє сесії, що перевищили ліміти, і повідомляє в чат про завершені. Повертає true, поки є що
	// відстежувати (працюють сесії чи лишились спостереження).
	private async tick(): Promise<boolean> {
		const watches = await this.ctx.storage.list<Watch>({ prefix: "watch:" });
		const container = this.ctx.container;
		if (!container?.running) {
			// Контейнер зупинився, а робота не завершилась: сказати про це й більше не стежити.
			for (const [key, w] of watches) await this.finishWatch(key, w, "⚠️ Контейнер зупинився, не дочекавшись завершення. Напиши уточнення, щоб продовжити.");
			return false;
		}
		if (watches.size > 0) this.listen(); // потік міг обірватись
		const oc = this.opencode();
		const active = new Set(await activeSessions(oc));
		const maxCost = positiveNumber(this.env.AGENT_MAX_COST_USD) ?? DEFAULT_MAX_COST_USD;
		const maxTokens = positiveInt(this.env.AGENT_MAX_TOKENS) ?? DEFAULT_MAX_TOKENS;
		const byOc = new Map([...watches].map(([key, w]) => [w.ocId, [key, w] as const]));

		for (const ocId of active) {
			const info = await getSession(oc, ocId);
			const tokens = totalTokens(info);
			const over = (info.cost ?? 0) > maxCost ? `вартість $${(info.cost ?? 0).toFixed(2)} (ліміт $${maxCost})` : tokens > maxTokens ? `${tokens} токенів (ліміт ${maxTokens})` : "";
			const watched = byOc.get(ocId);
			if (over) {
				// Спостереження знімаємо до зупинки: інакше подія «зупинено» покаже в чаті «⏹» замість причини.
				if (watched) await this.finishWatch(watched[0], watched[1], `⛔ Сесію зупинено: ${over}. Напиши уточнення, щоб продовжити з новим лімітом.`);
				await interrupt(oc, ocId).catch((err) => console.error("limit interrupt failed:", err));
				console.error(`session ${ocId} stopped: ${over}`);
			} else if (watched && !watched[1].seenBusy) {
				await this.ctx.storage.put(watched[0], { ...watched[1], seenBusy: true } satisfies Watch);
				watched[1].seenBusy = true;
			}
		}

		for (const [ocId, [key, w]] of byOc) {
			if (active.has(ocId) && (await this.ctx.storage.get(key))) {
				if (Date.now() - w.since > WATCH_MAX_MS) await this.finishWatch(key, w, "⚠️ Сесія надто довго працює: перестав стежити. Напиши уточнення, щоб продовжити.");
				continue;
			}
			if (!(await this.ctx.storage.get(key))) continue; // уже оброблено вище (ліміт)
			// Вільна: або вже відпрацювала, або ще не стартувала (дамо їй трохи часу).
			if (!w.seenBusy && Date.now() - w.since < WATCH_INTERVAL_MS + 5000) continue;
			await this.finishWatch(key, w, await this.summary(oc, w));
		}
		return (await this.ctx.storage.list({ prefix: "watch:" })).size > 0 || active.size > 0;
	}

	// Підсумок завершеної роботи: останнє повідомлення асистента, помилка чи нічого, якщо користувач сам зупинив.
	private async summary(oc: Opencode, w: Watch): Promise<string> {
		const [info, last] = await Promise.all([getSession(oc, w.ocId), lastAssistant(oc, w.ocId)]);
		if (info.outcome === "interrupted") return "⏹ Зупинено. Відповідь на цей пост продовжить роботу.";
		if (info.outcome === "failed") return `❌ Помилка: ${last.error ?? (last.text || "невідома")}`.slice(0, SUMMARY_MAX);
		const text = last.text.length > SUMMARY_MAX ? `${last.text.slice(0, SUMMARY_MAX)}…` : last.text;
		return `✅ Готово${text ? `\n\n${text}` : ""}`;
	}

	// 👨‍💻 на пості сесії, поки вона працює (як на нотатці, що редагується); збій не критичний.
	private async mark(w: WatchTarget, on: boolean): Promise<void> {
		if (!w.postId || !this.env.BOT_TOKEN) return;
		await tg({ BOT_TOKEN: this.env.BOT_TOKEN }, "setMessageReaction", { chat_id: w.chatId, message_id: w.postId, reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [] }).catch((err) => console.error("reaction failed:", err));
	}

	// Пост сесії: шапка (завдання) і поточний стан чи підсумок. З підсумком шапка скорочується, щоб усе влізло в 4096 символів.
	private postText(w: WatchTarget, status: string, final: boolean): string {
		const header = (w.header ?? "").trim();
		return [final && header.length > HEADER_FINAL_MAX ? `${header.slice(0, HEADER_FINAL_MAX)}…` : header, status].filter(Boolean).join("\n\n");
	}

	// Оновлює пост сесії на місці. false — поста немає чи редагування не вдалось.
	private async show(w: WatchTarget, status: string, final = false, answers?: Answers): Promise<boolean> {
		if (!w.postId || !this.env.BOT_TOKEN) return false;
		return editChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.postId, this.postText(w, status, final), w.url, final ? "done" : "working", answers);
	}

	// Забирає спостереження (щоб не повідомити двічі) і показує результат у пості сесії; без поста (чи якщо його видалили) шле нове повідомлення.
	private async finishWatch(key: string, w: Watch, text: string): Promise<void> {
		if (!(await this.ctx.storage.get(key))) return; // уже показано (подія й опитування можуть збігтися)
		await this.ctx.storage.delete(key);
		await this.ctx.storage.delete(formKey(key.slice("watch:".length))); // питання, що лишилось без відповіді, неактуальне
		this.lastProgress.delete(w.ocId);
		this.recent.delete(w.ocId);
		this.narration.delete(w.ocId);
		await this.postQueue.catch(() => undefined); // проміжна правка вже в дорозі: підсумок іде після неї
		await this.mark(w, false);
		if (!this.env.BOT_TOKEN) return;
		if (await this.show(w, text, true)) return;
		await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, text, w.url, "done").catch((err) => console.error("notify failed:", err));
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
		if (!this.ctx.container?.running) throw new Error("container is not running");
		if (await isAnyBusy(this.opencode())) throw new Error("an agent is busy");
		return this.saveSnapshot();
	}

	// Після деплою старий контейнер може ще працювати й зробити знімок старої файлової системи під новим образом;
	// це єдиний спосіб його позбутися без SSH: знімок видаляється, контейнер зупиняється.
	async resetComputer(unlessBusy = false): Promise<boolean> {
		if (unlessBusy && this.ctx.container?.running && (await isAnyBusy(this.opencode()).catch(() => true))) return false;
		await this.ctx.storage.delete("snapshot");
		if (this.ctx.container?.running) await this.destroyContainer();
		return true;
	}

	// Готує теку сесії в контейнері (клон + worktree або порожня тека) і повертає її шлях. exec не успадковує env контейнера,
	// тому токен передаємо явно. Викликається лише всередині serial().
	private async prepare(folder: string, repo: string | undefined): Promise<string> {
		const proc = await this.ctx.container!.exec(["session-prep", folder, ...(repo ? [repo] : [])], {
			cwd: "/workspace",
			env: { HOME: "/root", ...(this.env.GITHUB_TOKEN && { GITHUB_TOKEN: this.env.GITHUB_TOKEN }) },
		});
		const out = await proc.output();
		if (out.exitCode !== 0) throw new Error(`session-prep failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).trim()}`);
		return new TextDecoder().decode(out.stdout).trim() || sessionDir(folder);
	}

	// Ідемпотентно за id: повторний виклик не створює другу сесію OpenCode й не готує теку вдруге.
	async start(id: string, input: StartInput): Promise<{ sessionId: string }> {
		await this.ensureRunning();
		const existing = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (existing) return { sessionId: existing.ocId };
		return this.serial(async () => {
			const again = await this.ctx.storage.get<Tracked>(sessionKey(id));
			if (again) return { sessionId: again.ocId };
			const folder = folderFor(id, input.name);
			const directory = await this.prepare(folder, input.repo);
			const ocId = await createSession(this.opencode(), input.prompt.slice(0, 80), directory, this.model());
			await this.ctx.storage.put(sessionKey(id), { ocId, repo: input.repo, folder } satisfies Tracked);
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
				const directory = await this.prepare(tracked.folder ?? id, tracked.repo);
				return createSession(this.opencode(), text.slice(0, 80), directory, this.model());
			});
			await this.ctx.storage.put(sessionKey(id), { ...tracked, ocId } satisfies Tracked);
		}
		await prompt(this.opencode(), ocId, text);
		await this.markActive();
	}

	// Id сесії OpenCode для прямого посилання (контейнер не будимо). Прийняте, але ще не запущене завдання теж «є» (повторна
	// доставка вебхука не створює другу сесію).
	async link(id: string): Promise<string | undefined> {
		return (await this.ctx.storage.get<Tracked>(sessionKey(id)))?.ocId ?? ((await this.ctx.storage.get(jobKey(id))) ? "pending" : undefined);
	}

	// Приймає нову сесію: зберігає завдання й будить alarm, сам запуск іде там (див. runJobs). Ідемпотентно за id.
	async begin(id: string, input: StartInput, target: WatchTarget): Promise<void> {
		if (await this.link(id)) return;
		await this.enqueue({ id, input, target, attempts: 0 });
	}

	// Те саме для уточнення; контейнер може спати.
	async resume(id: string, text: string, target: WatchTarget): Promise<void> {
		await this.enqueue({ id, text, target, attempts: 0 });
	}

	private async enqueue(job: Job): Promise<void> {
		await this.ctx.storage.put(jobKey(job.id), job);
		await this.ctx.storage.setAlarm(Date.now());
	}

	// Виконує прийняті завдання по одному. Повертає true, поки є що повторювати чи виконувати.
	private async runJobs(): Promise<boolean> {
		for (const [key, job] of await this.ctx.storage.list<Job>({ prefix: "job:" })) {
			try {
				if ("input" in job) {
					if (!this.ctx.container?.running) await this.show(job.target, "⏳ Запускаю контейнер").catch(() => {});
					await this.start(job.id, job.input);
				} else {
					await this.followUp(job.id, job.text);
				}
			} catch (err) {
				console.error(`job ${job.id} failed (attempt ${job.attempts + 1}):`, err);
				if (job.attempts + 1 < JOB_ATTEMPTS) {
					await this.ctx.storage.put(key, { ...job, attempts: job.attempts + 1 } satisfies Job);
					continue;
				}
				await this.ctx.storage.delete(key);
				await this.reportFailure(job);
				continue;
			}
			await this.ctx.storage.delete(key); // запущено: далі повтор уточнення чи старту не потрібен
			await this.watch(job.id, job.target).catch((err) => console.error("watch failed:", err));
			if ("input" in job) await this.show(job.target, WORKING).catch(() => {}); // пост із «Запускаю» → «Працює»
		}
		return (await this.ctx.storage.list({ prefix: "job:" })).size > 0;
	}

	private async reportFailure(job: Job): Promise<void> {
		const text = "⚠️ Не вдалося запустити агента. Надішли завдання ще раз.";
		if (!this.env.BOT_TOKEN) return;
		if (job.target.postId && (await this.show(job.target, text, true))) return;
		await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN }, job.target.chatId, text, job.target.url, "done").catch((err) => console.error("notify failed:", err));
	}

	// Статус не будить контейнер, що спить.
	async status(id: string): Promise<AgentStatus> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked || !this.ctx.container?.running) return "stopped";
		return (await isBusy(this.opencode(), tracked.ocId)) ? "working" : "idle";
	}

	async report(id: string): Promise<SessionReport> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked || !this.ctx.container?.running) return { status: "stopped" };
		const [busy, info] = await Promise.all([isBusy(this.opencode(), tracked.ocId), getSession(this.opencode(), tracked.ocId)]);
		const tokens = totalTokens(info);
		return { status: busy ? "working" : "idle", outcome: info.outcome, ...(info.cost && { cost: info.cost }), ...(tokens && { tokens }) };
	}

	// Стежить за сесією до завершення (див. tick). Контейнер не будить: сесія вже має працювати.
	async watch(id: string, target: WatchTarget): Promise<void> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked) throw new Error(`unknown session ${id}`);
		// Пост сесії: новий (з першого виклику) запам'ятовується, у наступних (уточнення) береться зі сховища.
		const post = target.postId ? { postId: target.postId, header: target.header ?? "", chatId: target.chatId, url: target.url } : tracked.post;
		if (target.postId) await this.ctx.storage.put(sessionKey(id), { ...tracked, post } satisfies Tracked);
		const full: WatchTarget = { chatId: target.chatId, url: target.url, ...post };
		const previous = await this.ctx.storage.get<Watch>(watchKey(id));
		if (previous?.postId && previous.postId !== full.postId) await this.mark(previous, false); // реакція не лишається на старому пості
		await this.ctx.storage.put(watchKey(id), { ocId: tracked.ocId, ...full, since: Date.now(), seenBusy: false } satisfies Watch);
		await this.mark(full, true);
		if (!target.postId && post) await this.show(full, WORKING); // уточнення: пост знову показує «Працює»
		this.listen();
		await this.scheduleSoon();
	}

	// Підписка на події OpenCode (SSE): підсумок приходить у чат одразу, як сесія завершилась, а не за наступним опитуванням
	// (опитування раз на WATCH_INTERVAL_MS лишається страховкою: збій потоку, подія до початку стеження, ліміти витрат).
	// Потік живе, лише поки є що відстежувати: інакше він тримав би контейнер активним.
	private listen(): void {
		if (this.events || !this.ctx.container?.running) return;
		const stop = new AbortController();
		this.events = stop;
		void readEvents(this.opencode(), stop.signal, async (event) => {
			if (event) return this.onEvent(event);
			if ((await this.ctx.storage.list({ prefix: "watch:" })).size === 0) stop.abort();
		})
			.catch((err) => {
				if (!stop.signal.aborted) console.error("event stream failed:", err);
			})
			.finally(() => {
				if (this.events === stop) this.events = undefined;
			});
	}

	// Старт роботи відмічає сесію працюючою, кінець (успіх, помилка, зупинка) одразу показує підсумок у пості.
	private async onEvent(event: OpencodeEvent): Promise<void> {
		const ocId = event.data?.sessionID;
		// Агент поставив питання й чекає відповіді: показуємо його одразу, без тротлінгу (далі оновлень не буде).
		if (event.type === "form.created" && event.data?.form?.sessionID) return this.ask(event.data.form);
		if (ocId && event.type === "session.tool.input.started" && event.data?.id && event.data.name) {
			if (this.toolNames.size > 500) this.toolNames.clear();
			this.toolNames.set(event.data.id, event.data.name);
			return;
		}
		if (ocId && event.type === "session.tool.called" && event.data?.id) {
			const tool = this.toolNames.get(event.data.id) ?? "";
			if (tool) this.recent.set(ocId, remember(this.recent.get(ocId) ?? [], describeCall(tool, event.data.input)));
			return this.progress(ocId, tool, event.data.input);
		}
		const kind = event.type.startsWith("session.execution.") ? event.type.slice("session.execution.".length) : "";
		if (!ocId || !["started", "succeeded", "failed", "interrupted"].includes(kind)) return;
		const entry = [...(await this.ctx.storage.list<Watch>({ prefix: "watch:" }))].find(([, w]) => w.ocId === ocId);
		if (!entry) return;
		const [key, w] = entry;
		if (kind === "started") return void (w.seenBusy || (await this.ctx.storage.put(key, { ...w, seenBusy: true } satisfies Watch)));
		await this.finishWatch(key, w, await this.summary(this.opencode(), w));
	}

	// Питання агента: текст у пост, а для простих (один вибір, так/ні) ще й кнопки-відповіді.
	private async ask(form: OpencodeForm): Promise<void> {
		const entry = [...(await this.ctx.storage.list<Watch>({ prefix: "watch:" }))].find(([, w]) => w.ocId === form.sessionID);
		if (!entry) return;
		const id = entry[0].slice("watch:".length);
		const found = form.id ? formChoices(form) : undefined;
		const text = describeForm(form);
		if (found && form.id) await this.ctx.storage.put(formKey(id), { formId: form.id, ocId: entry[1].ocId, key: found.key, choices: found.choices, multiple: found.multiple, selected: [], text } satisfies PendingForm);
		await this.progress(entry[1].ocId, "", undefined, text, found && { labels: found.choices.map((c) => c.label), multiple: found.multiple });
	}

	// Відповідь кнопкою: передає вибраний варіант агентові й показує його в пості. undefined — питання вже неактуальне.
	async answer(id: string, choice: number | "ok"): Promise<string | undefined> {
		const form = await this.ctx.storage.get<PendingForm>(formKey(id));
		if (!form) return undefined;
		const w = await this.ctx.storage.get<Watch>(watchKey(id));
		const sent = async (value: string | boolean | string[], label: string) => {
			await replyForm(this.opencode(), form.ocId, form.formId, { [form.key]: value });
			await this.ctx.storage.delete(formKey(id));
			if (w) await this.show(w, `${WORKING} · відповідь: ${label}`).catch(() => {});
			return `Відповідь: ${label}`;
		};
		if (!form.multiple) {
			const picked = choice === "ok" ? undefined : form.choices[choice];
			return picked && (await sent(picked.value, picked.label));
		}
		// Множинний вибір: кнопки перемикають варіанти (позначка в підписі), «Підтвердити» надсилає вибране.
		if (choice === "ok") {
			if (form.selected.length === 0) return "Вибери хоча б один варіант.";
			const picked = form.selected.sort((a, b) => a - b).map((i) => form.choices[i]);
			return sent(picked.map((c) => c.value as string), picked.map((c) => c.label).join(", "));
		}
		if (!form.choices[choice]) return undefined;
		const selected = form.selected.includes(choice) ? form.selected.filter((i) => i !== choice) : [...form.selected, choice];
		await this.ctx.storage.put(formKey(id), { ...form, selected } satisfies PendingForm);
		const labels = form.choices.map((c, i) => `${selected.includes(i) ? "☑" : "☐"} ${c.label}`);
		if (w) await this.show(w, form.text, false, { labels, multiple: true }).catch(() => {});
		return selected.length ? `Вибрано: ${selected.sort((a, b) => a - b).map((i) => form.choices[i].label).join(", ")}` : "Нічого не вибрано";
	}

	// «⏳ Працює · редагує README.md»: пост оновлюється на місці, не частіше за PROGRESS_INTERVAL_MS (проміжні дії між оновленнями пропускаються).
	// announcement: готовий текст (питання агента) замість підпису дії; показується завжди, навіть частіше за інтервал.
	private async progress(ocId: string, tool: string, input: Record<string, unknown> | undefined, announcement?: string, answers?: Answers): Promise<void> {
		if ((!tool && !announcement) || !this.env.BOT_TOKEN) return;
		const now = Date.now();
		if (!announcement && now - (this.lastProgress.get(ocId) ?? 0) < (positiveInt(this.env.AGENT_PROGRESS_MS) ?? PROGRESS_INTERVAL_MS)) return;
		const entry = [...(await this.ctx.storage.list<Watch>({ prefix: "watch:" }))].find(([, w]) => w.ocId === ocId);
		if (!entry?.[1].postId) return;
		this.lastProgress.set(ocId, now);
		const w = entry[1];
		// Що відбувається, каже маленька модель за завданням і останніми діями; без неї (збій, тайм-аут) — технічний підпис.
		let activity = "";
		if (!announcement) {
			activity = (await narrate(workersLlm({ AI: this.env.AI, OPENAI_KEY: this.env.OPENAI_API_KEY }), w.header ?? "", this.recent.get(ocId) ?? [], this.narration.get(ocId))) ?? "";
			if (activity) this.narration.set(ocId, activity);
		}
		const text = announcement ?? `${WORKING} · ${activity || describeActivity(tool, input)}`;
		const job = this.postQueue.catch(() => undefined).then(async () => {
			if (await this.ctx.storage.get(entry[0])) await this.show(w, text, false, answers); // спостереження могло закінчитись, поки чекали в черзі
		});
		this.postQueue = job;
		await job;
	}

	// Найближчий alarm: не пізніше за інтервал опитування.
	private async scheduleSoon(): Promise<void> {
		const at = Date.now() + WATCH_INTERVAL_MS;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	async abort(id: string): Promise<void> {
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked || !this.ctx.container?.running) return;
		await interrupt(this.opencode(), tracked.ocId);
	}

	// Видалення сесії: історія в OpenCode, worktree (або порожня тека) і записи в сховищі. Гілка agent/<назва> видаляється, якщо роботу не
	// втрачено (див. CLEANUP); незакомічене зникає. Невідома сесія: нічого не робимо.
	async remove(id: string): Promise<void> {
		await this.ctx.storage.delete(formKey(id));
		await this.ctx.storage.delete(jobKey(id)); // завдання, яке ще не запустилось, скасовується
		const tracked = await this.ctx.storage.get<Tracked>(sessionKey(id));
		if (!tracked) return;
		await this.ensureRunning();
		await interrupt(this.opencode(), tracked.ocId).catch(() => {});
		await deleteSession(this.opencode(), tracked.ocId);
		await this.serial(async () => {
			const proc = await this.ctx.container!.exec(
				["sh", "-c", CLEANUP, "sh", tracked.folder ?? id],
				// exec не успадковує env контейнера: для видалення сайтів сесії (publish --delete) потрібен доступ до бакета сайтів
				{ cwd: "/workspace", env: { HOME: "/root", ...publishEnv(this.env) } },
			);
			const out = await proc.output();
			if (out.exitCode !== 0) console.error(`remove ${id}: cleanup failed (${out.exitCode}): ${new TextDecoder().decode(out.stderr).trim()}`);
		});
		await this.ctx.storage.delete(sessionKey(id));
		await this.ctx.storage.delete(watchKey(id));
	}

	// PR з гілки agent/<folder> змерджено: прибирає сесію цієї гілки (див. remove). Повертає сесію й її пост у чаті, щоб
	// викликач прибрав і його; undefined, якщо такої сесії немає.
	async removeByBranch(repo: string, folder: string): Promise<RemovedSession | undefined> {
		const all = await this.ctx.storage.list<Tracked>({ prefix: "session:" });
		for (const [key, tracked] of all) {
			const id = key.slice("session:".length);
			if ((tracked.folder ?? id) !== folder || tracked.repo !== repo) continue;
			await this.remove(id);
			return { id, chatId: tracked.post?.chatId, postId: tracked.post?.postId };
		}
		return undefined;
	}

	// Стан для діагностики: чому контейнер не засинає, коли був знімок.
	async info(): Promise<ComputerInfo> {
		const [activeAt, alarmAt, snapshot] = await Promise.all([
			this.ctx.storage.get<number>("activeAt"),
			this.ctx.storage.getAlarm(),
			this.ctx.storage.get<SavedSnapshot>("snapshot"),
		]);
		return {
			running: !!this.ctx.container?.running,
			activeAt: activeAt ?? null,
			alarmAt,
			snapshot: snapshot ? { id: snapshot.id, at: snapshot.at } : null,
			streams: [...this.streams.values()],
		};
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

	// Повідомлення з веб-інтерфейсу в сесію, що має пост у чаті: стежимо за нею так само, як за запущеною з чату (стан, питання, підсумок
	// у пості). Повідомлення з чату йдуть повз цей проксі, тому дублів немає.
	private async watchPrompted(ocId: string): Promise<void> {
		for (const [key, tracked] of await this.ctx.storage.list<Tracked>({ prefix: "session:" })) {
			if (tracked.ocId !== ocId || !tracked.post?.chatId || !tracked.post.url) continue;
			return this.watch(key.slice("session:".length), { chatId: tracked.post.chatId, url: tracked.post.url });
		}
	}

	// Веб-інтерфейс OpenCode: запити (разом із SSE) проксуються в контейнер.
	async fetch(request: Request): Promise<Response> {
		await this.ensureRunning();
		// Зміни з веб-інтерфейсу (повідомлення, правки) теж треба зберегти; читання й SSE — ні.
		if (!["GET", "HEAD"].includes(request.method)) await this.markActive();
		const promptedOc = request.method === "POST" ? new URL(request.url).pathname.match(/^\/api\/session\/([^/]+)\/prompt$/)?.[1] : undefined;
		const url = new URL(request.url);
		const headers = new Headers(request.headers);
		headers.set("authorization", basicAuth(this.env.OPENCODE_PASSWORD));
		headers.delete("host");
		headers.delete("cookie"); // cookie Access контейнеру не потрібні
		// OpenCode відхиляє запити термінала (connect-token, WebSocket), якщо Origin не збігається з Host контейнера; без Origin
		// (як у не-браузерних клієнтів) перевірка проходить. Доступ уже захищено Access і паролем.
		headers.delete("origin");
		const upstream = new Request(`http://container${url.pathname}${url.search}`, new Request(request, { headers })) as unknown as Request<unknown, CfProperties>;
		const port = this.ctx.container!.getTcpPort(OPENCODE_PORT);
		if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
			const res = await port.fetch(upstream);
			if (promptedOc && res.ok) await this.watchPrompted(promptedOc).catch((err) => console.error("watch of web prompt failed:", err));
			return res;
		}

		// SSE: обмежуємо час життя потоку й ведемо облік для діагностики.
		const id = ++this.streamSeq;
		this.streams.set(id, { path: url.pathname, openedAt: Date.now() });
		const stop = new AbortController();
		const done = () => {
			clearTimeout(timer);
			this.streams.delete(id);
		};
		const timer = setTimeout(() => {
			stop.abort();
			done();
		}, STREAM_MAX_MS);
		request.signal.addEventListener("abort", () => {
			stop.abort();
			done();
		});
		return port.fetch(new Request(upstream, { signal: stop.signal }) as unknown as Request<unknown, CfProperties>);
	}
}

function positiveNumber(value: string | undefined): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function publishEnv(env: Env): Record<string, string> {
	const vars = { R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, R2_ENDPOINT: env.R2_ENDPOINT, SITES_BASE_URL: env.SITES_BASE_URL };
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

function containerEnv(env: Env): Record<string, string> {
	const vars: Record<string, string | undefined> = {
		OPENCODE_PASSWORD: env.OPENCODE_PASSWORD,
		ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: env.OPENAI_API_KEY,
		GITHUB_TOKEN: env.GITHUB_TOKEN,
		CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
		// Публікація сайтів (команда publish): ключ R2 лише на бакет сайтів і адреса сайтів
		R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
		R2_ENDPOINT: env.R2_ENDPOINT,
		SITES_BASE_URL: env.SITES_BASE_URL,
		// Публічні сайти: окремий ключ лише на публічний бакет (endpoint спільний)
		PUBLIC_R2_ACCESS_KEY_ID: env.PUBLIC_R2_ACCESS_KEY_ID,
		PUBLIC_R2_SECRET_ACCESS_KEY: env.PUBLIC_R2_SECRET_ACCESS_KEY,
		PUBLIC_SITES_BASE_URL: env.PUBLIC_SITES_BASE_URL,
	};
	return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { folderFor, type McpAnswer, type McpName, type ImageRef, type DeployInfo, type PostRef, type AgentStatus, ComputerInfo, ConnectionsInfo, RemovedSession, FoundSession, SessionReport, SnapshotInfo, StartInput, WatchTarget } from "../../domain/agent";
import { stopwatch } from "../../timing";
import { removeTopic } from "../chat";
import { CLEANUP } from "./cleanup";
import { Computer } from "./computer";
import { JOB_RETRY_MS, WATCH_INTERVAL_MS, publishEnv } from "./config";
import { Forms } from "./forms";
import { loadImages } from "./images";
import { Jobs } from "./jobs";
import { Limits } from "./limits";
import { Mcp } from "./mcp";
import { createSession, deleteSession, getSession, hasModel, interrupt, totalTokens, isBusy, prompt, sessionExists, switchModel, type Opencode } from "./opencode";
import { Posts } from "./posts";
import { Progress } from "./progress";
import { WebProxy } from "./proxy";
import { FORM_PREFIX, type PendingForm, type Tracked } from "./state";
import { SessionStore } from "./store";
import { Watcher } from "./watcher";

// Спільний комп'ютер агента: один Durable Object (ім'я `main`) володіє єдиним контейнером з OpenCode, а сесії агентів
// (кожна в своїй теці, для репозиторію в окремому git worktree) живуть усередині нього. Клас називається AgentSession
// історично: перейменування потребувало б міграції Durable Object.
//
// Тут лише сесії: завдання, стеження за ними, події OpenCode і підсумки. Решту робить окремий модуль: Computer (контейнер і знімки),
// Posts (пост у чаті й деплой), Forms (питання агента), WebProxy (веб-інтерфейс). Публічні методи — RPC-вхід порту Agent.
export class AgentSession extends DurableObject<Env> {
	private readonly computer: Computer;
	private readonly posts: Posts;
	private readonly forms: Forms;
	private readonly store: SessionStore;
	private readonly limits: Limits;
	private readonly proxy: WebProxy;
	private readonly mcp: Mcp;
	private readonly jobs: Jobs;
	private readonly progress: Progress;
	private readonly watcher: Watcher;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.computer = new Computer(ctx, env);
		this.store = new SessionStore(ctx.storage);
		this.limits = new Limits(env, this.store, (at) => this.computer.alarmNoLater(at));
		this.posts = new Posts(ctx.storage, env, this.store);
		this.forms = new Forms(ctx.storage, this.posts, () => this.computer.opencode());
		this.proxy = new WebProxy(ctx, env, this.computer);
		this.mcp = new Mcp(ctx.storage, env, this.store, this.computer, (id, tracked, text) => this.tell(id, tracked, text));
		this.progress = new Progress(env, this.store, this.posts, this.forms);
		this.watcher = new Watcher(ctx.storage, env, this.store, this.computer, this.posts, this.forms, this.limits, this.progress, this.mcp);
		this.jobs = new Jobs(ctx, env, this.store, this.posts, {
			running: () => this.computer.running,
			start: (id, input) => this.start(id, input),
			followUp: (id, text, images) => this.followUp(id, text, images),
			watch: (id, target) => this.watcher.watch(id, target),
		});
		this.computer.applyInactivityTimeout();
	}

	private opencode(): Opencode {
		return this.computer.opencode();
	}

	// Alarm зберігає диск контейнера, коли агенти вільні і з минулого знімка щось змінилось. Перепланує себе лише поки
	// є що зберігати: постійний alarm не давав би контейнеру заснути.
	async alarm(): Promise<void> {
		const next = await this.limits.check();
		try {
			await this.work();
		} finally {
			// Чекаємо скидання лімітів: alarm має спрацювати ще раз, навіть якщо решта справ його не планувала.
			if (next) await this.computer.alarmNoLater(next);
		}
	}

	private async work(): Promise<void> {
		if (await this.jobs.run()) return void (await this.computer.alarmNoLater(Date.now() + JOB_RETRY_MS));
		// Поки хтось працює чи за кимось стежать, опитуємо часто (підсумки, ліміти) й знімок відкладаємо.
		if (await this.watcher.tick()) {
			await this.computer.markUsed();
			return void (await this.computer.alarmNoLater(Date.now() + WATCH_INTERVAL_MS));
		}
		// Агент чекає відповіді на питання: питання живе в пам'яті OpenCode, тож контейнер тримаємо довше (FORM_HOLD_MS).
		const forms = await this.ctx.storage.list<PendingForm>({ prefix: FORM_PREFIX });
		await this.computer.settle(Math.max(0, ...[...forms.values()].map((f) => f.askedAt ?? 0)));
	}

	// Деплой PR сесії у пості (див. Posts).
	setDeploy(repo: string, folder: string, deploy: DeployInfo): Promise<boolean> {
		return this.posts.setDeploy(repo, folder, deploy);
	}

	setDeployByPost(postId: number, deploy: DeployInfo, force = false): Promise<boolean> {
		return this.posts.setDeployByPost(postId, deploy, force);
	}

	saveRef(key: string, ref: PostRef): Promise<void> {
		return this.posts.saveRef(key, ref);
	}

	takeRef(key: string): Promise<PostRef | undefined> {
		return this.posts.takeRef(key);
	}

	// Контейнер: знімки, скидання, діагностика (див. Computer).
	silpoLoginUrl(origin: string): Promise<string> {
		return this.mcp.silpo.loginUrl(origin);
	}

	silpoCallback(code: string, state: string): Promise<boolean> {
		return this.mcp.silpo.callback(code, state);
	}

	silpoConnected(): Promise<boolean> {
		return this.mcp.silpo.connected();
	}

	calendarLoginUrl(origin: string): Promise<string> {
		return this.mcp.calendar.loginUrl(origin);
	}

	calendarCallback(code: string, state: string): Promise<boolean> {
		return this.mcp.calendar.callback(code, state);
	}

	calendarConnected(): Promise<boolean> {
		return this.mcp.calendar.connected();
	}

	cloudflareLoginUrl(origin: string): Promise<string> {
		return this.mcp.cloudflare.loginUrl(origin);
	}

	cloudflareCallback(code: string, state: string): Promise<boolean> {
		return this.mcp.cloudflare.callback(code, state);
	}

	cloudflareConnected(): Promise<boolean> {
		return this.mcp.cloudflare.connected();
	}

	snapshot(): Promise<SnapshotInfo> {
		return this.computer.snapshot();
	}

	resetComputer(unlessBusy = false): Promise<boolean> {
		return this.computer.reset(unlessBusy);
	}

	async info(): Promise<ComputerInfo> {
		return this.computer.info(this.proxy.open());
	}

	connections(detail: boolean): Promise<ConnectionsInfo> {
		return this.computer.connections(detail);
	}

	fetch(request: Request): Promise<Response> {
		return this.proxy.handle(request, (ocId) => this.watcher.watchPrompted(ocId));
	}

	answer(id: string, choice: number | "ok"): Promise<string | undefined> {
		return this.forms.answer(id, choice);
	}

	// Гілка сесії й репозиторій (для кнопки «Змерджити»); undefined, якщо сесія без репозиторію.
	async pullTarget(id: string): Promise<{ repo: string; branch: string } | undefined> {
		const tracked = await this.store.session(id);
		return tracked?.repo ? { repo: tracked.repo, branch: `agent/${tracked.folder ?? id}` } : undefined;
	}

	// Ідемпотентно за id: повторний виклик не створює другу сесію OpenCode й не готує теку вдруге.
	async start(id: string, input: StartInput): Promise<{ sessionId: string }> {
		const sw = stopwatch(`session ${id} start`);
		await this.computer.ensureRunning();
		sw.mark("container");
		const existing = await this.store.session(id);
		if (existing) return { sessionId: existing.ocId };
		return this.computer.serial(async () => {
			const again = await this.store.session(id);
			if (again) return { sessionId: again.ocId };
			const folder = folderFor(id, input.name);
			const { silpo, calendar, cloudflare } = await this.mcp.wanted(input);
			sw.mark("queue");
			const directory = await this.computer.prepare(folder, input.repo, { sure: input.sure, silpo, calendar, cloudflare });
			sw.mark("prepare");
			const ocId = await createSession(this.opencode(), input.prompt.slice(0, 80), directory, this.computer.model(input.model));
			sw.mark("create");
			await this.store.saveSession(id, { ocId, repo: input.repo, folder, ...(input.model && { model: input.model }), ...(input.sure && { sure: true }), ...(silpo && { silpo: true }), ...(calendar && { calendar: true }), ...(cloudflare && { cloudflare: true }) } satisfies Tracked);
			const notes = Mcp.missing(input, { silpo, calendar, cloudflare });
			await prompt(this.opencode(), ocId, notes.length ? `${input.prompt}\n\n(Системна примітка: ${notes.join(" ")})` : input.prompt, await this.images(input.images));
			sw.mark("prompt");
			sw.log({ repo: input.repo ?? "-" });
			await this.computer.markActive();
			return { sessionId: ocId };
		});
	}

	// Уточнення в сесію. Якщо сесії OpenCode вже немає (диск не відновився зі знімка), готуємо теку заново й створюємо нову.
	async followUp(id: string, text: string, images?: ImageRef[]): Promise<void> {
		const tracked = await this.store.session(id);
		if (!tracked) throw new Error(`unknown session ${id}`);
		await this.computer.ensureRunning();
		let ocId = tracked.ocId;
		if (!(await sessionExists(this.opencode(), ocId))) {
			ocId = await this.computer.serial(async () => {
				const directory = await this.computer.prepare(tracked.folder ?? id, tracked.repo, await this.mcp.wanted(tracked));
				return createSession(this.opencode(), text.slice(0, 80), directory, this.computer.model(tracked.model));
			});
			await this.store.saveSession(id, { ...tracked, ocId } satisfies Tracked);
		}
		await this.mcp.refresh(id, tracked);
		this.progress.asked(id, text);
		await this.limits.forget(id);
		await this.forms.cancel(id, text); // текст замість кнопки: відкрите питання не чекає далі
		await prompt(this.opencode(), ocId, text, await this.images(images));
		await this.computer.markActive();
	}

	// Фото з Telegram → вкладення для моделі (без BOT_TOKEN, напр. у тестах, їх немає).
	private async images(refs: ImageRef[] | undefined) {
		return refs?.length && this.env.BOT_TOKEN ? loadImages({ BOT_TOKEN: this.env.BOT_TOKEN }, refs) : [];
	}

	// Змінює модель сесії для наступних ходів і запам'ятовує її (нова сесія OpenCode після сну теж піде на ній).
	async setModel(id: string, requested: string): Promise<boolean> {
		const tracked = await this.store.session(id);
		if (!tracked) throw new Error(`unknown session ${id}`);
		const model = this.computer.model(requested);
		if (!model) return false;
		await this.computer.ensureRunning();
		if (!(await hasModel(this.opencode(), model))) return false;
		if (await sessionExists(this.opencode(), tracked.ocId)) await switchModel(this.opencode(), tracked.ocId, model);
		await this.store.saveSession(id, { ...tracked, model: requested } satisfies Tracked);
		return true;
	}

	// Id сесії OpenCode для прямого посилання (контейнер не будимо). Прийняте, але ще не запущене завдання теж «є» (повторна
	// доставка вебхука не створює другу сесію).
	async link(id: string): Promise<string | undefined> {
		return (await this.store.session(id))?.ocId ?? ((await this.store.job(id)) ? "pending" : undefined);
	}

	// Приймає нову сесію чи уточнення в чергу завдань (див. Jobs).
	begin(id: string, input: StartInput, target: WatchTarget): Promise<void> {
		return this.jobs.begin(id, input, target);
	}

	resume(id: string, text: string, target: WatchTarget, images?: ImageRef[]): Promise<void> {
		return this.jobs.resume(id, text, target, images);
	}

	// Стежить за сесією до завершення (див. Watcher).
	watch(id: string, target: WatchTarget): Promise<void> {
		return this.watcher.watch(id, target);
	}

	// Статус не будить контейнер, що спить.
	async status(id: string): Promise<AgentStatus> {
		const tracked = await this.store.session(id);
		if (!tracked || !this.computer.running) return "stopped";
		return (await isBusy(this.opencode(), tracked.ocId)) ? "working" : "idle";
	}

	async report(id: string): Promise<SessionReport> {
		const tracked = await this.store.session(id);
		if (!tracked || !this.computer.running) return { status: "stopped" };
		const [busy, info] = await Promise.all([isBusy(this.opencode(), tracked.ocId), getSession(this.opencode(), tracked.ocId)]);
		const tokens = totalTokens(info);
		return { status: busy ? "working" : "idle", outcome: info.outcome, ...(info.cost && { cost: info.cost }), ...(tokens && { tokens }) };
	}

	// Відповідь власника на запит MCP (див. Mcp.answer).
	answerMcp(id: string, name: McpName, allow: boolean): Promise<McpAnswer> {
		return this.mcp.answer(id, name, allow);
	}

	// Повідомлення агентові від воркера: як уточнення від власника (job: сесія прокидається, а пост знову показує «Працює»).
	private async tell(id: string, tracked: Tracked, text: string): Promise<void> {
		const post = tracked.post;
		if (post?.chatId && post.url) await this.jobs.enqueue({ id, text, target: { chatId: post.chatId, url: post.url, ...(post.threadId && { threadId: post.threadId }) }, attempts: 0 });
		else await this.followUp(id, text);
	}

	async abort(id: string): Promise<void> {
		const tracked = await this.store.session(id);
		if (!tracked || !this.computer.running) return;
		await interrupt(this.opencode(), tracked.ocId);
	}

	// Видалення сесії: історія в OpenCode, worktree (або порожня тека) і записи в сховищі. Гілка agent/<назва> видаляється, якщо роботу не
	// втрачено (див. CLEANUP); незакомічене зникає. Невідома сесія: нічого не робимо.
	async remove(id: string): Promise<void> {
		await this.forms.drop(id);
		await this.store.dropJob(id); // завдання, яке ще не запустилось, скасовується
		const tracked = await this.store.session(id);
		if (!tracked) return;
		await this.computer.ensureRunning();
		await interrupt(this.opencode(), tracked.ocId).catch(() => {});
		await deleteSession(this.opencode(), tracked.ocId);
		await this.computer.serial(async () => {
			// exec не успадковує env контейнера: для видалення сайтів сесії (publish --delete) потрібен доступ до бакета сайтів
			const out = await this.computer.run(["sh", "-c", CLEANUP, "sh", tracked.folder ?? id], publishEnv(this.env));
			if (out.exitCode !== 0) console.error(`remove ${id}: cleanup failed (${out.exitCode}): ${out.stderr}`);
		});
		await this.store.dropSession(id);
		await this.store.dropWatch(id);
		this.progress.removed(id);
		if (tracked.post) await this.posts.forget(tracked.post.postId);
		// Тема сесії зникає разом із нею (усі шляхи видалення — чат, кнопка, веб, мердж PR — проходять тут).
		if (tracked.post?.threadId && tracked.post.chatId && this.env.BOT_TOKEN) await removeTopic({ BOT_TOKEN: this.env.BOT_TOKEN }, tracked.post.chatId, tracked.post.threadId);
	}

	// Сесія з постом у темі (див. Sessions.byThread).
	async byThread(chatId: number, threadId: number): Promise<string | undefined> {
		for (const [id, tracked] of await this.store.sessions()) {
			if (tracked.post?.threadId === threadId && tracked.post.chatId === chatId) return id;
		}
		// Сесія, що ще не запустилась (холодний старт, клон): її тема відома лише із завдання в черзі. Без цього повідомлення,
		// надіслане в цей час, стартувало б у тій самій темі нову сесію.
		for (const job of await this.store.jobs()) {
			if (job.target.threadId === threadId && job.target.chatId === chatId) return job.id;
		}
		return undefined;
	}

	// PR з гілки agent/<folder> змерджено: прибирає сесію цієї гілки (див. remove). Повертає сесію й її пост у чаті, щоб
	// викликач прибрав і його; undefined, якщо такої сесії немає.
	async removeByBranch(repo: string, folder: string): Promise<RemovedSession | undefined> {
		// Сесія без репозиторію теж підходить: назва гілки agent/<назва> унікальна.
		const found = await this.store.sessionByBranch(repo, folder, true);
		if (!found) return undefined;
		const [id, tracked] = found;
		await this.remove(id);
		return { id, chatId: tracked.post?.chatId, postId: tracked.post?.postId };
	}

	// Сесія гілки agent/<folder> без змін (див. Sessions.findByBranch).
	async findByBranch(repo: string, folder: string): Promise<FoundSession | undefined> {
		const found = await this.store.sessionByBranch(repo, folder, false);
		return found && { id: found[0], chatId: found[1].post?.chatId, threadId: found[1].post?.threadId };
	}

}

import { workersLlm } from "@voice-notes/core";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { folderFor, type McpAnswer, type McpName, type ImageRef, type DeployInfo, type PostRef, type AgentStatus, ComputerInfo, ConnectionsInfo, RemovedSession, FoundSession, SessionReport, SnapshotInfo, StartInput, WatchTarget } from "../../domain/agent";
import { removeTopic, renameTopic, sendChat, setTopicIcon, type Answers, type TopicState } from "../chat";
import { openPullNumber } from "../github";
import { CLEANUP } from "./cleanup";
import { Computer } from "./computer";
import { Mcp, requestedMcp } from "./mcp";
import { settedRepo } from "./repo";
import { stamp, stopwatch } from "../../timing";
import { JOB_RETRY_MS, SUMMARY_MAX, WATCH_INTERVAL_MS, WATCH_MAX_MS, WORKING, maxCostUsd, maxTokens, progressMs, publishEnv } from "./config";
import { describeActivity, describeForm, formChoices, formSteps } from "./activity";
import { Forms } from "./forms";
import { extractImages, loadImages, sendImages, type OutImage } from "./images";
import { describeCall, narrate, remember } from "./narrate";
import { activeSessions, createSession, deleteSession, getSession, hasModel, interrupt, lastAssistant, totalTokens, isBusy, prompt, readEvents, type OpencodeEvent, type OpencodeForm, sessionExists, switchModel, type Opencode } from "./opencode";
import { DEPLOY_ICON, Posts } from "./posts";
import { retitle } from "./title";
import { isLimitError } from "../quota";
import { WebProxy } from "./proxy";
import { FORM_PREFIX, deployKey, type PendingForm, type Tracked, type Watch } from "./state";
import { SessionStore } from "./store";
import { Jobs } from "./jobs";
import { Limits } from "./limits";

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
	// Підписка на події OpenCode, поки за якоюсь сесією стежать (див. listen).
	private events: AbortController | undefined;
	// Назви інструментів за id виклику й час останнього оновлення поста сесії.
	private toolNames = new Map<string, string>();
	private lastProgress = new Map<string, number>();
	// Останні дії агента (для маленької моделі, що описує поточну дію) і її попередній опис — за id сесії OpenCode.
	private recent = new Map<string, string[]>();
	private narration = new Map<string, string>();
	// Останнє уточнення власника за id сесії: з ним модель вирішує, чи змінився напрям розмови (назва теми).
	private asks = new Map<string, string>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.computer = new Computer(ctx, env);
		this.store = new SessionStore(ctx.storage);
		this.limits = new Limits(env, this.store, (at) => this.computer.alarmNoLater(at));
		this.posts = new Posts(ctx.storage, env, this.store);
		this.forms = new Forms(ctx.storage, this.posts, () => this.computer.opencode());
		this.proxy = new WebProxy(ctx, env, this.computer);
		this.mcp = new Mcp(ctx.storage, env, this.store, this.computer, (id, tracked, text) => this.tell(id, tracked, text));
		this.jobs = new Jobs(ctx, env, this.store, this.posts, {
			running: () => this.computer.running,
			start: (id, input) => this.start(id, input),
			followUp: (id, text, images) => this.followUp(id, text, images),
			watch: (id, target) => this.watch(id, target),
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
		if (await this.tick()) {
			await this.computer.markUsed();
			return void (await this.computer.alarmNoLater(Date.now() + WATCH_INTERVAL_MS));
		}
		// Агент чекає відповіді на питання: питання живе в пам'яті OpenCode, тож контейнер тримаємо довше (FORM_HOLD_MS).
		const forms = await this.ctx.storage.list<PendingForm>({ prefix: FORM_PREFIX });
		await this.computer.settle(Math.max(0, ...[...forms.values()].map((f) => f.askedAt ?? 0)));
	}

	// Один оберт опитування: зупиняє сесії, що перевищили ліміти, і повідомляє в чат про завершені. Повертає true, поки є що
	// відстежувати (працюють сесії чи лишились спостереження).
	private async tick(): Promise<boolean> {
		const watches = await this.store.watches();
		if (!this.computer.running) {
			// Контейнер зупинився, а робота не завершилась: сказати про це й більше не стежити.
			for (const [id, w] of watches) await this.finishWatch(id, w, "⚠️ Контейнер зупинився, не дочекавшись завершення. Напиши уточнення, щоб продовжити.");
			return false;
		}
		if (watches.length > 0) this.listen(); // потік міг обірватись
		const oc = this.opencode();
		const active = new Set(await activeSessions(oc));
		const maxCost = maxCostUsd(this.env);
		const tokenLimit = maxTokens(this.env);
		const byOc = new Map(watches.map(([id, w]) => [w.ocId, [id, w] as const]));

		for (const ocId of active) {
			if (!byOc.has(ocId)) await this.watchPrompted(ocId).catch((err) => console.error("rewatch failed:", err)); // працює без стеження (страховка до подій)
			// Сесія ще в списку активних, але її вже немає: пропускаємо, інакше кожен alarm падав би в 404 і повторювався.
			const info = await getSession(oc, ocId).catch((err) => {
				if (!String(err).includes("SessionNotFoundError")) throw err;
				console.error(`active session ${ocId} is gone, skipping`);
				return undefined;
			});
			if (!info) {
				active.delete(ocId); // нижче її стеження знімається через summary (там теж 404)
				continue;
			}
			const tokens = totalTokens(info);
			const over = (info.cost ?? 0) > maxCost ? `вартість $${(info.cost ?? 0).toFixed(2)} (ліміт $${maxCost})` : tokens > tokenLimit ? `${tokens} токенів (ліміт ${tokenLimit})` : "";
			const watched = byOc.get(ocId);
			if (over) {
				// Спостереження знімаємо до зупинки: інакше подія «зупинено» покаже в чаті «⏹» замість причини.
				if (watched) await this.finishWatch(watched[0], watched[1], `⛔ Сесію зупинено: ${over}. Напиши уточнення, щоб продовжити з новим лімітом.`);
				await interrupt(oc, ocId).catch((err) => console.error("limit interrupt failed:", err));
				console.error(`session ${ocId} stopped: ${over}`);
			} else if (watched && !watched[1].seenBusy) {
				await this.store.saveWatch(watched[0], { ...watched[1], seenBusy: true });
				watched[1].seenBusy = true;
				console.log(`latency session ${watched[0]} first-busy=${Date.now() - watched[1].since}ms at=${stamp()} (poll)`);
			}
		}

		for (const [ocId, [id, w]] of byOc) {
			if (active.has(ocId) && (await this.store.watch(id))) {
				if (Date.now() - w.since > WATCH_MAX_MS) await this.finishWatch(id, w, "⚠️ Сесія надто довго працює: перестав стежити. Напиши уточнення, щоб продовжити.");
				continue;
			}
			if (!(await this.store.watch(id))) continue; // уже оброблено вище (ліміт)
			// Вільна: або вже відпрацювала, або ще не стартувала (дамо їй трохи часу).
			if (!w.seenBusy && Date.now() - w.since < WATCH_INTERVAL_MS + 5000) continue;
			// Сесії OpenCode вже немає (диск не відновився, її видалили): підсумок не отримати, тож знімаємо спостереження. Інакше
			// кожен оберт alarm знову впирався б у 404, і сесія стежила б вічно.
			const done = await this.summary(oc, w).catch((err) => {
				if (!String(err).includes("SessionNotFoundError")) throw err;
				console.error(`session ${w.ocId} is gone, dropping watch ${id}`);
				return { text: "⚠️ Сесії OpenCode вже немає (диск контейнера не відновився). Напиши уточнення, щоб продовжити." };
			});
			await this.finishWatch(id, w, done.text, "images" in done ? done.images : undefined, "limit" in done && done.limit);
		}
		return (await this.store.watching()) || active.size > 0;
	}

	// Підсумок завершеної роботи: останнє повідомлення асистента, помилка чи нічого, якщо користувач сам зупинив.
	// Зображення з відповіді агента (`![підпис](шлях)`) не потрапляють у текст, а йдуть у чат окремими фото (див. finishWatch).
	private async summary(oc: Opencode, w: Watch): Promise<{ text: string; images?: OutImage[]; limit?: boolean }> {
		const [info, last] = await Promise.all([getSession(oc, w.ocId), lastAssistant(oc, w.ocId)]);
		if (info.outcome === "interrupted") return { text: "⏹ Зупинено. Відповідь на цей пост продовжить роботу." };
		if (info.outcome === "failed") {
			const error = last.error ?? (last.text || "невідома");
			// Cloudflare перед API моделі інколи блокує IP контейнера (сторінка-челендж 403): це тимчасово, достатньо повторити.
			if (/403/.test(error) && /Cloudflare/i.test(error)) return { text: "❌ Cloudflare тимчасово заблокував запит до API моделі (403 Attention Required). Це не помилка завдання: відповідь на цей пост повторить роботу за кілька хвилин." };
			// Ліміти підписки Claude: це не помилка завдання, тож пропонуємо повторити, а коли вони скинуться, бот напише сам.
			if (isLimitError(error)) return { text: `⏳ Ліміти Claude вичерпано. Коли вони скинуться, я напишу; повторити можна й зараз кнопкою.\n\n${error}`.slice(0, SUMMARY_MAX), limit: true };
			return { text: `❌ Помилка: ${error}`.slice(0, SUMMARY_MAX) };
		}
		const { text: body, images } = extractImages(last.text);
		const text = body.length > SUMMARY_MAX ? `${body.slice(0, SUMMARY_MAX)}…` : body;
		return { text: `✅ Готово${text ? `\n\n${text}` : ""}`, images };
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
		return this.proxy.handle(request, (ocId) => this.watchPrompted(ocId));
	}

	answer(id: string, choice: number | "ok"): Promise<string | undefined> {
		return this.forms.answer(id, choice);
	}

	// Гілка сесії й репозиторій (для кнопки «Змерджити»); undefined, якщо сесія без репозиторію.
	async pullTarget(id: string): Promise<{ repo: string; branch: string } | undefined> {
		const tracked = await this.store.session(id);
		return tracked?.repo ? { repo: tracked.repo, branch: `agent/${tracked.folder ?? id}` } : undefined;
	}

	// Чи є в гілки сесії відкритий PR (тоді під підсумком з'являється «Змерджити»). Якщо кнопки не буде, повертає причину для поста.
	private async pullCheck(id: string): Promise<{ ok: boolean; why?: string }> {
		const target = await this.pullTarget(id);
		if (!target) return { ok: false }; // сесія без репозиторію
		const token = this.env.GITHUB_TOKEN;
		if (!token) return { ok: false, why: "у воркері немає GITHUB_TOKEN" };
		try {
			const number = await openPullNumber(token, target.repo, target.branch);
			return number ? { ok: true } : { ok: false, why: `немає відкритого PR з гілки ${target.branch}` };
		} catch (err) {
			console.error("open pull lookup failed:", err);
			return { ok: false, why: `збій пошуку PR (${err instanceof Error ? err.message : String(err)})` };
		}
	}

	// Забирає спостереження (щоб не повідомити двічі) і показує результат у пості сесії; без поста (чи якщо його видалили) шле нове повідомлення.
	private async finishWatch(id: string, w: Watch, text: string, images: OutImage[] = [], limit = false): Promise<void> {
		if (!(await this.store.watch(id))) return; // уже показано (подія й опитування можуть збігтися)
		await this.store.dropWatch(id);
		await this.forms.drop(id); // питання, що лишилось без відповіді, неактуальне
		this.lastProgress.delete(w.ocId);
		this.recent.delete(w.ocId);
		this.narration.delete(w.ocId);
		await this.posts.settled(); // проміжна правка вже в дорозі: підсумок іде після неї
		await this.posts.mark(w, false);
		if (!this.env.BOT_TOKEN) return;
		// Якщо PR сесії вже в деплої, іконку лишає стадія деплою, а не «готово»
		// Деплой PR записано на початковий пост сесії, а не на повідомлення стану ходу (воно може бути іншим).
		const sessionPost = (await this.store.session(id))?.post?.postId ?? w.postId;
		const deploy = sessionPost ? await this.ctx.storage.get<DeployInfo>(deployKey(sessionPost)) : undefined;
		await this.icon(w, deploy?.stage ? DEPLOY_ICON[deploy.stage] : /^[❌⛔⚠]/u.test(text) ? "failed" : "done");
		// Підсумок успішної роботи: якщо агент відкрив PR, додаємо «Змерджити» (зупинену чи невдалу сесію не мерджимо з чату)
		const check = text.startsWith("✅") ? await this.pullCheck(id) : { ok: false };
		const mergeable = check.ok;
		if (check.why) text += `\n\nℹ️ Кнопку «Змерджити» не показано: ${check.why}.`;
		if (limit) await this.limits.wait(id, w);
		const shown = await this.posts.show(w, text, true, undefined, mergeable, limit);
		await this.retitle(id, w, text);
		// Поста немає (чи його видалили): підсумок окремим повідомленням з тими самими кнопками.
		if (!shown) await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, text, w.url, limit ? "retry" : mergeable ? "mergeable" : "done", undefined, undefined, w.threadId).catch((err) => console.error("notify failed:", err));
		if (images.length > 0) await sendImages({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, images, (path) => this.computer.readImage(path), w.threadId);
	}

	// Іконка теми показує стан сесії (працює, питання, готово, збій); поза темою нічого не робить.
	private async icon(w: Watch | WatchTarget, state: TopicState): Promise<void> {
		if (w.threadId && this.env.BOT_TOKEN) await setTopicIcon({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.threadId, state);
	}

	// Після ходу агента назва теми або лишається, або оновлюється, якщо напрям розмови змінився (лише для тем, створених ботом).
	// Службові повідомлення (збій, ліміт, зупинка) назву не міняють. Збій моделі чи Telegram не критичний.
	private async retitle(id: string, w: Watch, result: string): Promise<void> {
		try {
			if (!result.startsWith("✅") || !w.threadId || !w.title || !this.env.BOT_TOKEN) return;
			const tracked = await this.store.session(id);
			const current = tracked?.post?.title;
			if (!tracked?.post || !current) return;
			const title = await retitle(workersLlm(this.env), current, (w.header ?? "").replace(/[]/g, ""), this.asks.get(id), result);
			if (!title || title === current) return;
			if (await renameTopic({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.threadId, title)) await this.store.saveSession(id, { ...tracked, post: { ...tracked.post, title } } satisfies Tracked);
		} catch (err) {
			console.error("retitle failed:", err);
		}
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
		this.asks.set(id, text);
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

	// Стежить за сесією до завершення (див. tick). Контейнер не будить: сесія вже має працювати.
	async watch(id: string, target: WatchTarget): Promise<void> {
		const tracked = await this.store.session(id);
		if (!tracked) throw new Error(`unknown session ${id}`);
		// Пост сесії: новий (з першого виклику) запам'ятовується, у наступних (уточнення) береться зі сховища.
		const post = target.postId ? { postId: target.postId, header: target.header ?? "", chatId: target.chatId, url: target.url, ...(target.threadId && { threadId: target.threadId }), ...(target.title && { title: target.title }) } : tracked.post;
		if (target.postId) await this.store.saveSession(id, { ...tracked, post } satisfies Tracked);
		const full: WatchTarget = { chatId: target.chatId, url: target.url, ...post };
		const previous = await this.store.watch(id);
		if (previous?.postId && previous.postId !== full.postId) await this.posts.mark(previous, false); // реакція не лишається на старому пості
		await this.store.saveWatch(id, { ocId: tracked.ocId, ...full, since: Date.now(), seenBusy: false } satisfies Watch);
		await this.posts.mark(full, true);
		await this.icon(full, "working");
		if (!target.postId && post) await this.posts.show(full, WORKING); // уточнення: пост знову показує «Працює»
		this.listen();
		await this.computer.alarmNoLater(Date.now() + WATCH_INTERVAL_MS);
	}

	// Підписка на події OpenCode (SSE): підсумок приходить у чат одразу, як сесія завершилась, а не за наступним опитуванням
	// (опитування раз на WATCH_INTERVAL_MS лишається страховкою: збій потоку, подія до початку стеження, ліміти витрат).
	// Потік живе, лише поки є що відстежувати: інакше він тримав би контейнер активним.
	private listen(): void {
		if (this.events || !this.computer.running) return;
		const stop = new AbortController();
		this.events = stop;
		void readEvents(this.opencode(), stop.signal, async (event) => {
			if (event) return this.onEvent(event);
			if (!(await this.store.watching())) stop.abort();
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
			const wanted = (tool === "bash" || tool === "shell") ? requestedMcp(event.data.input) : undefined;
			if (wanted) await this.mcp.request(ocId, wanted).catch((err) => console.error("mcp request failed:", err));
			const repo = (tool === "bash" || tool === "shell") ? settedRepo(event.data.input) : undefined;
			if (repo) await this.adoptRepo(ocId, repo).catch((err) => console.error("set-repo failed:", err));
			return this.progress(ocId, tool, event.data.input);
		}
		const kind = event.type.startsWith("session.execution.") ? event.type.slice("session.execution.".length) : "";
		if (!ocId || !["started", "succeeded", "failed", "interrupted"].includes(kind)) return;
		const entry = await this.store.watchByOc(ocId);
		if (!entry) {
			// Сесія знову працює без стеження (агент сам продовжив хід, напр. після фонової команди): беремо її під нагляд, щоб підсумок дійшов у чат.
			if (kind === "started") await this.watchPrompted(ocId).catch((err) => console.error("rewatch failed:", err));
			return;
		}
		const [id, w] = entry;
		if (kind === "started") {
			if (!w.seenBusy) {
				await this.store.saveWatch(id, { ...w, seenBusy: true });
				console.log(`latency session ${id} first-busy=${Date.now() - w.since}ms at=${stamp()} (event)`);
			}
			return;
		}
		const done = await this.summary(this.opencode(), w);
		await this.finishWatch(id, w, done.text, done.images, done.limit);
	}

	// Агент повідомив репозиторій сесії (команда set-repo): запам'ятовуємо його, якщо на старті репозиторій не визначили.
	private async adoptRepo(ocId: string, repo: string): Promise<void> {
		const found = await this.store.sessionByOc(ocId);
		if (!found || found[1].repo) return;
		await this.store.saveSession(found[0], { ...found[1], repo });
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

	// Питання агента: текст у пост, а для простих (один вибір, так/ні) ще й кнопки-відповіді.
	private async ask(form: OpencodeForm): Promise<void> {
		const entry = form.sessionID ? await this.store.watchByOc(form.sessionID) : undefined;
		if (!entry) return;
		const [id] = entry;
		const [first, ...next] = (form.id && formSteps(form)) || [];
		const found = first ?? (form.id ? formChoices(form) : undefined);
		const text = first?.text ?? describeForm(form);
		// Форму без кнопок (довільний текст) теж зберігаємо: відповідь текстом її скасує (див. followUp)
		if (form.id) await this.forms.save(id, { askedAt: Date.now(), formId: form.id, ocId: entry[1].ocId, key: found?.key ?? "", choices: found?.choices ?? [], multiple: found?.multiple, selected: [], text, next, answers: {} } satisfies PendingForm);
		await this.progress(entry[1].ocId, "", undefined, text, found && { labels: found.choices.map((c) => c.label), multiple: found.multiple });
		await this.icon(entry[1], "question");
	}

	// «⏳ Працює · редагує README.md»: пост оновлюється на місці, не частіше за PROGRESS_INTERVAL_MS (проміжні дії між оновленнями пропускаються).
	// announcement: готовий текст (питання агента) замість підпису дії; показується завжди, навіть частіше за інтервал.
	private async progress(ocId: string, tool: string, input: Record<string, unknown> | undefined, announcement?: string, answers?: Answers): Promise<void> {
		if ((!tool && !announcement) || !this.env.BOT_TOKEN) return;
		const now = Date.now();
		if (!announcement && now - (this.lastProgress.get(ocId) ?? 0) < progressMs(this.env)) return;
		const entry = await this.store.watchByOc(ocId);
		if (!entry?.[1].postId) return;
		this.lastProgress.set(ocId, now);
		const w = entry[1];
		// Що відбувається, каже маленька модель за завданням і останніми діями; без неї (збій, тайм-аут) — технічний підпис.
		let activity = "";
		if (!announcement) {
			activity = (await narrate(workersLlm(this.env), (w.header ?? "").replace(/[\uE000\uE001]/g, ""), this.recent.get(ocId) ?? [], this.narration.get(ocId))) ?? "";
			if (activity) this.narration.set(ocId, activity);
		}
		const text = announcement ?? `${WORKING} · ${activity || describeActivity(tool, input)}`;
		await this.posts.enqueue(async () => {
			if (await this.store.watch(entry[0])) await this.posts.show(w, text, false, answers); // спостереження могло закінчитись, поки чекали в черзі
		});
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
		this.asks.delete(id);
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

	// Повідомлення з веб-інтерфейсу в сесію, що має пост у чаті: стежимо за нею так само, як за запущеною з чату (стан, питання, підсумок
	// у пості). Повідомлення з чату йдуть повз цей проксі, тому дублів немає.
	private async watchPrompted(ocId: string): Promise<void> {
		for (const [id, tracked] of await this.store.sessions()) {
			if (tracked.ocId !== ocId || !tracked.post?.chatId || !tracked.post.url) continue;
			return this.watch(id, { chatId: tracked.post.chatId, url: tracked.post.url });
		}
	}
}

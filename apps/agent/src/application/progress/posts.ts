import { QUOTE_CLOSE, QUOTE_OPEN } from "@voice-notes/telegram-format";
import type { DeployInfo, DeployStage, PostBoard, PostButtons, PostChat, PostRef, PostAnswers, PostStore, SessionStore, TopicState, Tracked, WatchTarget } from "../../domain/agent";

export const HEADER_DEPLOYED_MAX = 150; // шапка згорнутого поста після успішного деплою
export const HEADER_FINAL_MAX = 400; // шапка поста разом із підсумком (підсумок до SUMMARY_MAX) має вміститись у 4096

// Іконка теми за стадією деплою.
export const DEPLOY_ICON: Record<DeployStage, TopicState> = { approval: "approval", deploying: "deploying", deployed: "deployed", failed: "deployFailed" };

// Пост сесії в чаті: шапка (завдання) і поточний стан чи підсумок, який агент оновлює на місці, плюс стан деплою PR цієї сесії.
// Правила (що показати, які кнопки, обрізання шапки, іконка) тут; сам чат і сховище — за портами PostChat і PostStore.
export class Posts implements PostBoard {
	// Черга правок поста: запізніла проміжна правка не має затирати підсумок, тож підсумок чекає на неї (див. settled).
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly chat: PostChat,
		private readonly records: PostStore,
		private readonly sessions: SessionStore,
	) {}

	// 👨‍💻 на пості сесії, поки вона працює (як на нотатці, що редагується); збій не критичний.
	async mark(w: WatchTarget, on: boolean): Promise<void> {
		if (!w.postId || !this.chat.enabled) return;
		await this.chat.react(w.chatId, w.postId, on);
	}

	// Іконка теми показує стан сесії (працює, питання, готово, збій); поза темою нічого не робить.
	async icon(w: WatchTarget, state: TopicState): Promise<void> {
		if (w.threadId && this.chat.enabled) await this.chat.setIcon(w.chatId, w.threadId, state);
	}

	// Нова назва теми; false — теми немає чи перейменування не вдалось.
	async rename(w: WatchTarget, title: string): Promise<boolean> {
		if (!w.threadId || !this.chat.enabled) return false;
		return this.chat.rename(w.chatId, w.threadId, title);
	}

	// Шапка (завдання) і стан. З підсумком шапка скорочується, щоб усе влізло в 4096 символів.
	text(w: WatchTarget, status: string, final: boolean, max = HEADER_FINAL_MAX): string {
		const header = (w.header ?? "").trim();
		let head = header;
		if (final && header.length > max) {
			head = `${header.slice(0, max)}…`;
			if (head.includes(QUOTE_OPEN) && !head.includes(QUOTE_CLOSE)) head += QUOTE_CLOSE; // обрізана цитата лишається закритою
		}
		return [head, status].filter(Boolean).join("\n\n");
	}

	// Оновлює пост сесії на місці. false — поста немає чи редагування не вдалось.
	async show(id: string, w: WatchTarget, status: string, final = false, answers?: PostAnswers, mergeable = false, retry = false): Promise<boolean> {
		if (!w.postId || !this.chat.enabled) return false;
		// Стан деплою цього PR (запит на схвалення, результат) дописується під станом сесії; останній показаний стан запам'ятовується,
		// щоб вебхук GitHub міг перемалювати пост (див. applyDeploy).
		const deploy = await this.records.deploy(w.postId);
		await this.records.saveLast(w.postId, { status, final, mergeable });
		// Кнопки: поки працює — «Стоп»; після — «Повторити» (ліміти) чи «Змерджити» (є PR, деплою ще немає); після деплою — лише «Видалити».
		const buttons: PostButtons = deploy?.done ? "dismiss" : !final ? "working" : retry ? "retry" : mergeable && !deploy ? "mergeable" : "done";
		const review = deploy?.runId && deploy.repo ? { repo: deploy.repo, runId: deploy.runId } : undefined;
		// Успішний деплой: підсумок агента вже не актуальний, пост згортається до короткої шапки й результату деплою.
		const text = deploy?.done ? this.text(w, deploy.text, true, HEADER_DEPLOYED_MAX) : this.text(w, deploy ? `${status}\n\n${deploy.text}` : status, final);
		const shown = await this.chat.edit({ chatId: w.chatId, postId: w.postId, text, session: w.turn ? undefined : { id, url: w.url }, buttons, answers, review });
		// Табло й іконка теми завжди збігаються: фінальний стан у пості (✅ / ❌ чи стадія деплою) тут же виставляє й іконку
		// (повтор того ж стану в setTopicIcon пропускається); проміжні стани й питання іконку ставлять самі.
		if (final && w.threadId) {
			const state: TopicState | undefined = deploy?.stage ? DEPLOY_ICON[deploy.stage] : status.startsWith("✅") ? "done" : status.startsWith("❌") ? "failed" : undefined;
			if (state) await this.chat.setIcon(w.chatId, w.threadId, state);
		}
		return shown;
	}

	// Ставить правку в чергу після попередніх; спостереження могло закінчитись, поки чекали, тож працю виконує викликач.
	enqueue(edit: () => Promise<unknown>): Promise<unknown> {
		const job = this.queue.catch(() => undefined).then(edit);
		this.queue = job;
		return job;
	}

	// Чекає, поки проміжна правка, що вже в дорозі, завершиться.
	async settled(): Promise<void> {
		await this.queue.catch(() => undefined);
	}

	// Дописує в пост сесії її деплой (запит на схвалення, результат) і перемальовує пост на місці. false — поста немає чи правка не вдалась.
	private async applyDeploy(id: string, post: NonNullable<Tracked["post"]>, deploy: DeployInfo): Promise<boolean> {
		if (!post.chatId || !post.url) return false;
		await this.records.saveDeploy(post.postId, deploy);
		if (post.threadId && deploy.stage && this.chat.enabled) await this.chat.setIcon(post.chatId, post.threadId, DEPLOY_ICON[deploy.stage]);
		const last = (await this.records.last(post.postId)) ?? { status: "✅ Готово", final: true, mergeable: false };
		return this.show(id, { chatId: post.chatId, url: post.url, postId: post.postId, header: post.header, ...(post.threadId && { threadId: post.threadId }) }, last.status, last.final);
	}

	// Деплой PR з гілки agent/<folder> у репозиторії repo: показує його в пості цієї сесії. false — сесії з постом немає (тоді вебхук шле окреме повідомлення).
	async setDeploy(repo: string, folder: string, deploy: DeployInfo): Promise<boolean> {
		for (const [id, tracked] of await this.sessions.sessions()) {
			// Сесія без репозиторію (його не визначили й агент не повідомив): гілка agent/<назва> унікальна, тож прив'язуємо за нею.
			if ((tracked.folder ?? id) === folder && (!tracked.repo || tracked.repo === repo) && tracked.post) {
				if (!tracked.repo) await this.sessions.saveSession(id, { ...tracked, repo });
				return this.applyDeploy(id, tracked.post, deploy);
			}
		}
		return false;
	}

	// Те саме за постом (після натискання «Схвалити/Відхилити»); false, якщо цей пост не показує деплою.
	// force: показати деплой, навіть якщо пост його ще не показував (напр. одразу після мерджу з чату).
	async setDeployByPost(postId: number, deploy: DeployInfo, force = false): Promise<boolean> {
		if (!force && !(await this.records.deploy(postId))) return false;
		for (const [id, tracked] of await this.sessions.sessions()) {
			if (tracked.post?.postId === postId) return this.applyDeploy(id, tracked.post, deploy);
		}
		return false;
	}

	// Пости, які пізніше оновлює вебхук GitHub (ключ → пост); забирається один раз.
	saveRef(key: string, ref: PostRef): Promise<void> {
		return this.records.saveRef(key, ref);
	}

	takeRef(key: string): Promise<PostRef | undefined> {
		return this.records.takeRef(key);
	}

	// Сесію прибрано: забуваємо й стан деплою та останній показаний стан її поста.
	forget(postId: number): Promise<void> {
		return this.records.forget(postId);
	}
}

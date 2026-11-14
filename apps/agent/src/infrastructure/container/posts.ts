import { tg } from "@voice-notes/core";
import type { DeployInfo, DeployStage, PostRef, WatchTarget } from "../../domain/agent";
import type { Env } from "../../env";
import { QUOTE_CLOSE, QUOTE_OPEN, editChat, sendChat, setTopicIcon, showKeys, threadUi, type Answers, type KeySet, type KeyState, type KeyView, type Buttons, type TopicState } from "../chat";
import { HEADER_DEPLOYED_MAX, HEADER_FINAL_MAX } from "./config";
import { SESSION_PREFIX, deployKey, lastKey, refKey, type LastShown, type Tracked } from "./state";

type KeysShown = { state: KeyState; view?: KeyView; messageId?: number };

// Іконка теми за стадією деплою.
export const DEPLOY_ICON: Record<DeployStage, TopicState> = { approval: "approval", deploying: "deploying", deployed: "deployed", failed: "deployFailed" };

// Пост сесії в чаті: шапка (завдання) і поточний стан чи підсумок, який агент оновлює на місці, плюс стан деплою PR цієї сесії.
export class Posts {
	// Черга правок поста: запізніла проміжна правка не має затирати підсумок, тож підсумок чекає на неї (див. settled).
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly env: Env,
	) {}

	// 👨‍💻 на пості сесії, поки вона працює (як на нотатці, що редагується); збій не критичний.
	async mark(w: WatchTarget, on: boolean): Promise<void> {
		if (!w.postId || !this.env.BOT_TOKEN) return;
		await tg({ BOT_TOKEN: this.env.BOT_TOKEN }, "setMessageReaction", { chat_id: w.chatId, message_id: w.postId, reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [] }).catch((err) => console.error("reaction failed:", err));
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
	async show(w: WatchTarget, status: string, final = false, answers?: Answers, mergeable = false, retry = false): Promise<boolean> {
		if (!w.postId || !this.env.BOT_TOKEN) return false;
		// Стан деплою цього PR (запит на схвалення, результат) дописується під станом сесії; останній показаний стан запам'ятовується,
		// щоб вебхук GitHub міг перемалювати пост (див. applyDeploy).
		const deploy = await this.storage.get<DeployInfo>(deployKey(w.postId));
		await this.storage.put(lastKey(w.postId), { status, final, mergeable } satisfies LastShown);
		const ui = await threadUi(this.env, !!w.threadId);
		const buttons: Buttons = ui.postButtons({ final, retry, mergeable: mergeable && !deploy, deployDone: !!deploy?.done });
		const review = deploy?.runId && deploy.repo && !ui.approvalKeys ? { repo: deploy.repo, runId: deploy.runId } : undefined;
		// Успішний деплой: підсумок агента вже не актуальний, пост згортається до короткої шапки й результату деплою.
		const text = deploy?.done ? this.text(w, deploy.text, true, HEADER_DEPLOYED_MAX) : this.text(w, deploy ? `${status}\n\n${deploy.text}` : status, final);
		return editChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.postId, text, w.url, buttons, answers, review);
	}

	// Клавіші внизу теми за станом сесії (лише режим messages; повтор того ж стану нічого не шле, але з екрана команд повертає до дій сесії).
	// Збій не критичний.
	async keys(w: { chatId: number; threadId?: number }, state: KeyState): Promise<void> {
		const set = w.threadId && this.env.BOT_TOKEN ? (await threadUi(this.env, true)).keys(state) : undefined;
		if (!set || !w.threadId) return;
		const last = await this.storage.get<KeysShown>(`keys:${w.chatId}:${w.threadId}`);
		if (last?.state === state && last.view !== "commands") return;
		await this.drawKeys({ chatId: w.chatId, threadId: w.threadId }, set, state, "session", last);
	}

	// Клавіші, які треба причепити до повідомлення зі станом, що надсилається зараз (sendChat, параметр keys): так окремого
	// повідомлення-носія, що повторює статус, не буде. Запам'ятовує стан як показаний; undefined — клавіші вже такі (чи режим
	// без клавіш), тоді повідомлення йде без них. Старе повідомлення-носій, якщо було, прибирається.
	async nextKeys(w: { chatId: number; threadId?: number }, state: KeyState): Promise<KeySet | undefined> {
		const set = w.threadId && this.env.BOT_TOKEN ? (await threadUi(this.env, true)).keys(state) : undefined;
		if (!set || !w.threadId) return undefined;
		const last = await this.storage.get<KeysShown>(`keys:${w.chatId}:${w.threadId}`);
		if (last?.state === state && last.view !== "commands") return undefined;
		await this.storage.put(`keys:${w.chatId}:${w.threadId}`, { state, view: "session" } satisfies KeysShown);
		if (last?.messageId) await tg({ BOT_TOKEN: this.env.BOT_TOKEN! }, "deleteMessage", { chat_id: w.chatId, message_id: last.messageId }).catch(() => {});
		return set;
	}

	// Перемикає клавіші внизу теми між діями сесії й екраном загальних команд («⚙️ Команди» / «← Назад»).
	async keyView(w: { chatId: number; threadId?: number }, view: KeyView): Promise<void> {
		if (!w.threadId || !this.env.BOT_TOKEN) return;
		const ui = await threadUi(this.env, true);
		const last = await this.storage.get<KeysShown>(`keys:${w.chatId}:${w.threadId}`);
		const state = last?.state ?? "done";
		// «Назад»: підпис нейтральний, щоб повідомлення-носій не повторювало статус, який уже є вище в темі.
		const session = ui.keys(state);
		const set = view === "commands" ? ui.commands() : session && { ...session, label: "↩️ Дії сесії" };
		if (set) await this.drawKeys({ chatId: w.chatId, threadId: w.threadId }, set, state, view, last);
	}

	private async drawKeys(w: { chatId: number; threadId: number }, set: KeySet, state: KeyState, view: KeyView, last?: KeysShown): Promise<void> {
		const messageId = await showKeys({ BOT_TOKEN: this.env.BOT_TOKEN! }, w.chatId, w.threadId, set, last?.messageId);
		await this.storage.put(`keys:${w.chatId}:${w.threadId}`, { state, view, ...(messageId && { messageId }) } satisfies KeysShown);
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
	private async applyDeploy(post: NonNullable<Tracked["post"]>, deploy: DeployInfo): Promise<boolean> {
		if (!post.chatId || !post.url) return false;
		const before = await this.storage.get<DeployInfo>(deployKey(post.postId));
		await this.storage.put(deployKey(post.postId), deploy);
		// Режим messages: зміна стану деплою ще й дописується новим повідомленням унизу теми (перший пост теж оновлюється нижче).
		// Клавіші за станом деплою йдуть разом із цим повідомленням; без нього (текст не змінився) — окремим носієм, якщо стан інший.
		const keyState = deploy.stage === "approval" ? "approval" : "done";
		const message = !!post.threadId && !!this.env.BOT_TOKEN && before?.text !== deploy.text && (await threadUi(this.env, true)).statusPerTurn;
		if (message) {
			const keys = await this.nextKeys({ chatId: post.chatId, threadId: post.threadId }, keyState);
			await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN! }, post.chatId, deploy.text, post.url, "none", undefined, undefined, post.threadId, keys).catch((err) => console.error("deploy message failed:", err));
		} else if (post.threadId) await this.keys({ chatId: post.chatId, threadId: post.threadId }, keyState).catch((err) => console.error("keys failed:", err));
		if (post.threadId && deploy.stage && this.env.BOT_TOKEN) await setTopicIcon({ BOT_TOKEN: this.env.BOT_TOKEN }, post.chatId, post.threadId, DEPLOY_ICON[deploy.stage]);
		const last = (await this.storage.get<LastShown>(lastKey(post.postId))) ?? { status: "✅ Готово", final: true, mergeable: false };
		return this.show({ chatId: post.chatId, url: post.url, postId: post.postId, header: post.header, ...(post.threadId && { threadId: post.threadId }) }, last.status, last.final);
	}

	// Деплой PR з гілки agent/<folder> у репозиторії repo: показує його в пості цієї сесії. false — сесії з постом немає (тоді вебхук шле окреме повідомлення).
	async setDeploy(repo: string, folder: string, deploy: DeployInfo): Promise<boolean> {
		for (const [key, tracked] of await this.storage.list<Tracked>({ prefix: SESSION_PREFIX })) {
			// Сесія без репозиторію (його не визначили й агент не повідомив): гілка agent/<назва> унікальна, тож прив'язуємо за нею.
			if ((tracked.folder ?? key.slice(SESSION_PREFIX.length)) === folder && (!tracked.repo || tracked.repo === repo) && tracked.post) {
				if (!tracked.repo) await this.storage.put(key, { ...tracked, repo } satisfies Tracked);
				return this.applyDeploy(tracked.post, deploy);
			}
		}
		return false;
	}

	// Те саме за постом (після натискання «Схвалити/Відхилити»); false, якщо цей пост не показує деплою.
	// force: показати деплой, навіть якщо пост його ще не показував (напр. одразу після мерджу з чату).
	async setDeployByPost(postId: number, deploy: DeployInfo, force = false): Promise<boolean> {
		if (!force && !(await this.storage.get(deployKey(postId)))) return false;
		for (const tracked of (await this.storage.list<Tracked>({ prefix: SESSION_PREFIX })).values()) {
			if (tracked.post?.postId === postId) return this.applyDeploy(tracked.post, deploy);
		}
		return false;
	}

	// Деплой, що чекає схвалення, у пості цієї сесії.
	async pendingReview(tracked: Tracked | undefined): Promise<{ postId: number; repo: string; runId: number } | undefined> {
		if (!tracked?.post) return undefined;
		const deploy = await this.storage.get<DeployInfo>(deployKey(tracked.post.postId));
		return deploy?.stage === "approval" && deploy.repo && deploy.runId ? { postId: tracked.post.postId, repo: deploy.repo, runId: deploy.runId } : undefined;
	}

	// Пости, які пізніше оновлює вебхук GitHub (ключ → пост); забирається один раз.
	async saveRef(key: string, ref: PostRef): Promise<void> {
		await this.storage.put(refKey(key), ref);
	}

	async takeRef(key: string): Promise<PostRef | undefined> {
		const ref = await this.storage.get<PostRef>(refKey(key));
		if (ref) await this.storage.delete(refKey(key));
		return ref;
	}

	// Сесію прибрано: забуваємо й стан деплою та останній показаний стан її поста.
	async forget(postId: number): Promise<void> {
		await Promise.all([this.storage.delete(deployKey(postId)), this.storage.delete(lastKey(postId))]);
	}
}

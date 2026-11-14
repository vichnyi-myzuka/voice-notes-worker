import { tg } from "@voice-notes/core";
import type { DeployInfo, DeployStage, PostRef, WatchTarget } from "../../domain/agent";
import type { Env } from "../../env";
import { QUOTE_CLOSE, QUOTE_OPEN, editChat, setTopicIcon, type Answers, type Buttons, type TopicState } from "../chat";
import { HEADER_DEPLOYED_MAX, HEADER_FINAL_MAX } from "./config";
import { SESSION_PREFIX, deployKey, lastKey, refKey, type LastShown, type Tracked } from "./state";

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
		const buttons: Buttons = deploy?.done ? "dismiss" : final ? (retry ? "retry" : mergeable && !deploy ? "mergeable" : "done") : "working";
		const review = deploy?.runId && deploy.repo ? { repo: deploy.repo, runId: deploy.runId } : undefined;
		// Успішний деплой: підсумок агента вже не актуальний, пост згортається до короткої шапки й результату деплою.
		const text = deploy?.done ? this.text(w, deploy.text, true, HEADER_DEPLOYED_MAX) : this.text(w, deploy ? `${status}\n\n${deploy.text}` : status, final);
		return editChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.postId, text, w.url, buttons, answers, review);
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
		await this.storage.put(deployKey(post.postId), deploy);
		if (post.threadId && deploy.stage && this.env.BOT_TOKEN) await setTopicIcon({ BOT_TOKEN: this.env.BOT_TOKEN }, post.chatId, post.threadId, DEPLOY_ICON[deploy.stage]);
		const last = (await this.storage.get<LastShown>(lastKey(post.postId))) ?? { status: "✅ Готово", final: true, mergeable: false };
		return this.show({ chatId: post.chatId, url: post.url, postId: post.postId, header: post.header }, last.status, last.final);
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

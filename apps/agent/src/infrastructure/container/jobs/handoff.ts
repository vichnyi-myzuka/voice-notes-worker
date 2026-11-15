import type { Handoff, HandoffSpawner, SessionStore, StartInput, WatchTarget } from "../../../domain/agent";
import { folderFor } from "../../../domain/agent";
import { handoffId } from "../../../application/watch";
import type { ChatEnv } from "../../../env";
import { QUOTE_CLOSE, QUOTE_OPEN, createTopic, sendChat, setTopicIcon } from "../../chat";

const POST_MAX = 3500;

// Створює з виклику handoff нову сесію: тема (у приваті з темами) і пост у чаті поруч із батьківською, далі звичайний старт.
export class Handoffs implements HandoffSpawner {
	constructor(
		private readonly env: ChatEnv,
		private readonly store: SessionStore,
		private readonly begin: (id: string, input: StartInput, target: WatchTarget) => Promise<void>,
	) {}

	async spawn(ocId: string, callId: string, handoff: Handoff): Promise<void> {
		if (!this.env.BOT_TOKEN) return;
		const found = await this.store.sessionByOc(ocId);
		const post = found?.[1].post;
		// Без поста в чаті (сесія з веб-API) нікому показати нову сесію: нічого не робимо.
		if (!found || !post?.chatId || !post.url) return;
		const [parentId, parent] = found;
		const id = handoffId(parentId, callId);
		const bot = { BOT_TOKEN: this.env.BOT_TOKEN };
		const repo = handoff.repo === undefined ? parent.repo : (handoff.repo ?? undefined);
		// Назва теми — з тексту задачі, а не з --name (kebab-case не схожий на назву, і її потім не перейменовують), як і в launchSession.
		const title = handoff.task.replace(/\s+/g, " ").slice(0, 60);
		// Нова тема лише там, де сесія материнська теж у темі (приватний чат); у каналі пост іде просто в чат.
		const thread = post.threadId ? await createTopic(bot, post.chatId, title) : undefined;
		// Довга задача — у згорнутій цитаті, як розшифровка голосового (тоді й пост не займає пів екрана).
		const clipped = handoff.task.length > POST_MAX ? `${handoff.task.slice(0, POST_MAX)}…` : handoff.task;
		const where = repo ? `📦 ${repo}\n🌿 agent/${folderFor(id, handoff.name)}` : "";
		const header = [[where, "↪️ Передано з іншої сесії"].filter(Boolean).join("\n"), `${QUOTE_OPEN}${clipped}${QUOTE_CLOSE}`].join("\n\n");
		const url = post.url.replace(parentId, id);
		const postId = await sendChat(bot, post.chatId, [header, "⏳ Запускаю"].join("\n\n"), { id, url }, "working", undefined, undefined, thread);
		const input: StartInput = { prompt: `${handoff.task}\n\n(Системна примітка: цю задачу передала інша сесія. Її історії в тебе немає: весь контекст у тексті вище.)`, ...(repo && { repo }), ...(handoff.name && { name: handoff.name }) };
		// Іконка одразу, а не після старту контейнера (інакше тема довго лишається зі стандартною).
		if (thread) await setTopicIcon(bot, post.chatId, thread, "working");
		await this.begin(id, input, { chatId: post.chatId, url, postId, header, ...(thread && { threadId: thread }), title });
	}
}

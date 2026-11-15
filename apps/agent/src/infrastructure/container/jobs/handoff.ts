import type { StartInput, WatchTarget } from "../../../domain/agent";
import { folderFor } from "../../../domain/agent";
import type { ChatEnv } from "../../../env";
import { createTopic, sendChat } from "../../chat";
import type { SessionStore } from "../state";

// Агент передає роботу в нову сесію командою `handoff [--repo …] [--name …] <<'EOF' … EOF` (payload/handoff.sh): воркер бачить
// її у виклику bash у потоці подій OpenCode (як request-mcp і set-repo) і разом із командою отримує текст heredoc.
const HANDOFF = /(?:^|[\s;&|(])handoff((?:[ \t]+--(?:repo|name)(?:=|[ \t]+)\S+)*)[ \t]*<<-?[ \t]*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?:\n|$|[;&|)])/;
const FLAG = /--(repo|name)(?:=|[ \t]+)(\S+)/g;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const POST_MAX = 3500;

// repo: undefined — як у поточної сесії, null — без репозиторію (--repo none)
export type Handoff = { task: string; repo?: string | null; name?: string };

// Передана задача з виклику інструмента bash (input.command) чи undefined, якщо це інша команда чи текст порожній.
export function handedOff(input: Record<string, unknown> | undefined): Handoff | undefined {
	const command = typeof input?.command === "string" ? input.command : "";
	const match = HANDOFF.exec(command);
	const task = match?.[4].trim();
	if (!match || !task) return undefined;
	const out: Handoff = { task };
	for (const [, flag, value] of match[1].matchAll(FLAG)) {
		const v = value.replace(/^["']|["']$/g, "");
		if (flag === "repo") out.repo = v === "none" ? null : REPO.test(v) ? v : out.repo;
		else if (NAME.test(v)) out.name = v;
	}
	return out;
}

// Id нової сесії від id батьківської й виклику інструмента: повтор тієї самої події не створює другу сесію.
export function handoffId(parentId: string, callId: string): string {
	let h = 0x811c9dc5;
	for (const c of callId) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
	return `${parentId}-h${(h >>> 0).toString(36)}`;
}

// Створює з виклику handoff нову сесію: тема (у приваті з темами) і пост у чаті поруч із батьківською, далі звичайний старт.
export class Handoffs {
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
		const title = handoff.name ?? handoff.task.replace(/\s+/g, " ").slice(0, 60);
		// Нова тема лише там, де сесія материнська теж у темі (приватний чат); у каналі пост іде просто в чат.
		const thread = post.threadId ? await createTopic(bot, post.chatId, title) : undefined;
		const clipped = handoff.task.length > POST_MAX ? `${handoff.task.slice(0, POST_MAX)}…` : handoff.task;
		const where = repo ? `📦 ${repo}\n🌿 agent/${folderFor(id, handoff.name)}` : "";
		const header = [clipped, [where, "↪️ Передано з іншої сесії"].filter(Boolean).join("\n")].join("\n\n");
		const url = post.url.replace(parentId, id);
		const postId = await sendChat(bot, post.chatId, [header, "⏳ Запускаю"].join("\n\n"), { id, url }, "working", undefined, undefined, thread);
		const input: StartInput = { prompt: `${handoff.task}\n\n(Системна примітка: цю задачу передала інша сесія. Її історії в тебе немає: весь контекст у тексті вище.)`, ...(repo && { repo }), ...(handoff.name && { name: handoff.name }) };
		await this.begin(id, input, { chatId: post.chatId, url, postId, header, ...(thread && { threadId: thread }), title });
	}
}

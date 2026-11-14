import { tg, tgSendMessage } from "@voice-notes/core";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import type { NewSchedule, Outcome, Run, Schedule, SchedulePatch, Schedules } from "../../domain/schedule";
import { createTopic, scheduleCard, sendChat } from "../chat";
import { ScheduleBook, type Launcher } from "./book";

// Окремий Durable Object з розкладами автоматизацій (ADR 0005). Живе окремо від AgentSession і життя контейнера:
// сховище тримає записи, alarm стоїть на найближчий запуск, а сам запуск іде тим самим шляхом, що й завдання з Telegram (begin).
// Назва сесії-запуску й пост у чаті мають позначку «⏰ за розкладом».
export class Scheduler extends DurableObject<Env> implements Schedules {
	private readonly book: ScheduleBook;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.book = new ScheduleBook(ctx.storage, { set: (at) => ctx.storage.setAlarm(at), clear: () => ctx.storage.deleteAlarm() }, launcher(env));
	}

	async alarm(): Promise<void> {
		await this.book.tick();
	}

	list(): Promise<Schedule[]> {
		return this.book.list();
	}
	get(id: string): Promise<Schedule | undefined> {
		return this.book.get(id);
	}
	create(input: NewSchedule, createdBy: Schedule["createdBy"], origin: string): Promise<Outcome<Schedule>> {
		return this.book.create(input, createdBy, origin);
	}
	update(id: string, patch: SchedulePatch, by?: Schedule["createdBy"]): Promise<Outcome<Schedule>> {
		return this.book.update(id, patch, by);
	}
	pause(id: string): Promise<Outcome<Schedule>> {
		return this.book.pause(id);
	}
	resume(id: string): Promise<Outcome<Schedule>> {
		return this.book.resume(id);
	}
	runNow(id: string): Promise<Outcome<Run>> {
		return this.book.runNow(id);
	}
	remove(id: string): Promise<boolean> {
		return this.book.remove(id);
	}
}

// Запуск сесії за розкладом: пост у чаті власника (у новій темі, якщо чат їх підтримує) і begin у спільного агента.
function launcher(env: Env): Launcher {
	const chat = () => {
		const id = env.TG_OWNER_ID ?? env.CHAT_ID;
		if (!id) throw new Error("TG_OWNER_ID/CHAT_ID is not set");
		return { id: Number(id), threads: !!env.TG_OWNER_ID };
	};
	const bot = () => {
		if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
		return { BOT_TOKEN: env.BOT_TOKEN };
	};
	const agent = () => env.AGENT_SESSION.getByName("main");
	return {
		async launch(s, sessionId) {
			const { id: chatId, threads } = chat();
			const url = `${s.origin}/s/${sessionId}`;
			const title = `⏰ ${s.name}`;
			const threadId = threads ? await createTopic(bot(), chatId, title) : undefined;
			const header = [`⏰ за розкладом: ${s.name}`, s.prompt.length > 1500 ? `${s.prompt.slice(0, 1500)}…` : s.prompt, [s.repo && `📦 ${s.repo}`, s.model && `🤖 ${s.model}`].filter(Boolean).join("\n")].filter(Boolean).join("\n\n");
			const postId = await sendChat(bot(), chatId, `${header}\n\n⏳ Запускаю`, url, "working", undefined, undefined, threadId);
			await agent().begin(sessionId, { prompt: s.prompt, ...(s.repo && { repo: s.repo }), ...(s.model && { model: s.model }) }, { chatId, url, postId, header, ...(threadId && { threadId, title }) });
		},
		async running(sessionId) {
			return (await agent().status(sessionId)) === "working";
		},
		async propose(s) {
			const { text, reply_markup } = scheduleCard(s, "Агент пропонує автоматизацію");
			await tg(bot(), "sendMessage", { chat_id: chat().id, text, reply_markup });
		},
		async notify(text) {
			await tgSendMessage(bot(), chat().id, text);
		},
	};
}

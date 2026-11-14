import type { ImageRef, StartInput, WatchTarget } from "../../domain/agent";
import type { Env } from "../../env";
import { stamp } from "../../timing";
import { sendChat } from "../chat";
import { JOB_ATTEMPTS, JOB_STALE_MS, WORKING } from "./config";
import type { Posts } from "./posts";
import type { Job } from "./state";
import type { SessionStore } from "./store";

// Що завдання робить, коли до нього дійшла черга: старт сесії, уточнення й стеження (реалізує AgentSession).
export type JobRunner = {
	running(): boolean;
	start(id: string, input: StartInput): Promise<unknown>;
	followUp(id: string, text: string, images?: ImageRef[]): Promise<void>;
	watch(id: string, target: WatchTarget): Promise<void>;
};

// Черга прийнятих завдань (записи job:<id>): вебхук лише кладе завдання й будить alarm, а виконує його alarm у фоні з повторами
// (JOB_ATTEMPTS) і звітом власникові, якщо запустити так і не вдалося.
export class Jobs {
	// Завдання, що виконуються в цьому екземплярі Durable Object (після вивантаження набір порожній, і alarm підхоплює їх знову).
	private readonly active = new Set<string>();

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
		private readonly store: SessionStore,
		private readonly posts: Posts,
		private readonly runner: JobRunner,
	) {}

	// Чи сесія вже є або прийнята (повторна доставка вебхука не створює другу сесію).
	async known(id: string): Promise<boolean> {
		return !!(await this.store.session(id)) || !!(await this.store.job(id));
	}

	// Приймає нову сесію: зберігає завдання й будить alarm, сам запуск іде там (див. run). Ідемпотентно за id.
	async begin(id: string, input: StartInput, target: WatchTarget): Promise<void> {
		if (await this.known(id)) return;
		await this.enqueue({ id, input, target, attempts: 0 });
	}

	// Те саме для уточнення; контейнер може спати.
	async resume(id: string, text: string, target: WatchTarget, images?: ImageRef[]): Promise<void> {
		// Завдання одне на сесію (ключ job:<id>): уточнення, що прийшло, поки попереднє ще не почало виконуватись, не затирає його, а
		// додається до нього (інакше текст чи фото губиться, а в темі лишається «Працює» без відповіді).
		const queued = await this.store.job(id);
		if (queued && "text" in queued && !queued.startedAt) {
			const merged = [...(queued.images ?? []), ...(images ?? [])];
			await this.store.saveJob({ ...queued, text: `${queued.text}\n\n${text}`, target, ...(merged.length && { images: merged }) } satisfies Job);
			await this.ctx.storage.setAlarm(Date.now());
			return;
		}
		// Старт ще не почався: уточнення дописується до задачі старту (інакше нове завдання з тим самим ключем стерло б сам старт).
		if (queued && "input" in queued && !queued.startedAt) {
			const merged = [...(queued.input.images ?? []), ...(images ?? [])];
			await this.store.saveJob({ ...queued, input: { ...queued.input, prompt: `${queued.input.prompt}\n\n${text}`, ...(merged.length && { images: merged }) } } satisfies Job);
			await this.ctx.storage.setAlarm(Date.now());
			return;
		}
		await this.enqueue({ id, text, target, attempts: 0, ...(images?.length && { images }) });
	}

	// Нове завдання без злиття з тим, що вже в черзі (напр. повідомлення агентові від воркера).
	async enqueue(job: Job): Promise<void> {
		await this.store.saveJob({ ...job, queuedAt: Date.now() });
		await this.ctx.storage.setAlarm(Date.now());
	}

	// Запускає прийняті завдання у фоні й одразу повертається: alarm не чекає довгого старту (clone, контейнер), тож нове
	// повідомлення не стоїть за ним. Завдання з `startedAt` вважається виконуваним, доки не мине JOB_STALE_MS (страховка від
	// вивантаження). Клони йдуть по черзі в computer.serial, старт контейнера спільний (ensureRunning). Повертає true, поки є завдання.
	async run(): Promise<boolean> {
		for (const job of await this.store.jobs()) {
			if (this.active.has(job.id)) continue;
			if (job.startedAt && Date.now() - job.startedAt < JOB_STALE_MS) continue;
			const started: Job = { ...job, startedAt: Date.now() };
			await this.store.saveJob(started);
			this.active.add(job.id);
			this.ctx.waitUntil(this.runOne(started).catch((err) => console.error(`job ${job.id} crashed:`, err)).finally(() => this.active.delete(job.id)));
		}
		return (await this.store.jobs()).length > 0;
	}

	private async runOne(job: Job): Promise<void> {
		// Скільки завдання чекало на alarm і попередні завдання: від прийняття (begin/resume) до початку виконання.
		if (job.queuedAt && job.attempts === 0) console.log(`latency job ${job.id}: queued=${Date.now() - job.queuedAt}ms accepted=${stamp(job.queuedAt)} at=${stamp()} kind=${"input" in job ? "new" : "follow-up"} cold=${!this.runner.running()}`);
		try {
			if ("input" in job) {
				if (!this.runner.running()) await this.posts.show(job.target, "⏳ Запускаю контейнер").catch(() => {});
				await this.runner.start(job.id, job.input);
			} else {
				await this.runner.followUp(job.id, job.text, job.images);
			}
		} catch (err) {
			console.error(`job ${job.id} failed (attempt ${job.attempts + 1}):`, err);
			if (!(await this.isCurrent(job))) return; // за цей час у чергу став новіший запис: його не чіпаємо
			if (job.attempts + 1 < JOB_ATTEMPTS) {
				const { startedAt: _, ...rest } = job;
				await this.store.saveJob({ ...rest, attempts: job.attempts + 1 }); // знову готове до запуску наступним alarm
				return;
			}
			await this.store.dropJob(job.id);
			await this.reportFailure(job);
			return;
		}
		if (await this.isCurrent(job)) await this.store.dropJob(job.id); // запущено: далі повтор уточнення чи старту не потрібен
		await this.runner.watch(job.id, job.target).catch((err) => console.error("watch failed:", err));
		if ("input" in job) await this.posts.show(job.target, WORKING).catch(() => {}); // пост із «Запускаю» → «Працює»
	}

	// Чи запис черги досі той самий, що виконувався (уточнення, яке прийшло під час виконання, замінює запис новим queuedAt).
	private async isCurrent(job: Job): Promise<boolean> {
		const stored = await this.store.job(job.id);
		return !stored || stored.queuedAt === job.queuedAt;
	}

	private async reportFailure(job: Job): Promise<void> {
		const text = "⚠️ Не вдалося запустити агента. Надішли завдання ще раз.";
		if (!this.env.BOT_TOKEN) return;
		if (job.target.postId && (await this.posts.show(job.target, text, true))) return;
		await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN }, job.target.chatId, text, job.target.url, "done", undefined, undefined, job.target.threadId).catch((err) => console.error("notify failed:", err));
	}
}

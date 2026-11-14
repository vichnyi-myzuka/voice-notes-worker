import type { DeployInfo, WatchTarget } from "../../domain/agent";
import type { Env } from "../../env";
import { stamp } from "../../timing";
import { sendChat } from "../chat";
import { openPullNumber } from "../github";
import { isLimitError } from "../quota";
import type { Computer } from "./computer";
import { SUMMARY_MAX, WATCH_INTERVAL_MS, WATCH_MAX_MS, WORKING, maxCostUsd, maxTokens } from "./config";
import type { Forms } from "./forms";
import { extractImages, sendImages, type OutImage } from "./images";
import type { Limits } from "./limits";
import { requestedMcp, type Mcp } from "./mcp";
import { activeSessions, getSession, interrupt, lastAssistant, readEvents, totalTokens, type Opencode, type OpencodeEvent } from "./opencode";
import { DEPLOY_ICON, type Posts } from "./posts";
import type { Progress } from "./progress";
import { settedRepo } from "./repo";
import { deployKey, type Tracked, type Watch } from "./state";
import type { SessionStore } from "./store";

// Стеження за сесіями до підсумку: потік подій OpenCode (підсумок у чат одразу) і опитування в alarm як страховка (збій потоку,
// ліміти вартості й токенів, контейнер зупинився, сесія зникла). Спостереження — записи watch:<id>.
export class Watcher {
	// Підписка на події OpenCode, поки за якоюсь сесією стежать (див. listen).
	private events: AbortController | undefined;

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly env: Env,
		private readonly store: SessionStore,
		private readonly computer: Computer,
		private readonly posts: Posts,
		private readonly forms: Forms,
		private readonly limits: Limits,
		private readonly progress: Progress,
		private readonly mcp: Mcp,
	) {}

	// Один оберт опитування: зупиняє сесії, що перевищили ліміти, і повідомляє в чат про завершені. Повертає true, поки є що
	// відстежувати (працюють сесії чи лишились спостереження).
	async tick(): Promise<boolean> {
		const watches = await this.store.watches();
		if (!this.computer.running) {
			// Контейнер зупинився, а робота не завершилась: сказати про це й більше не стежити.
			for (const [id, w] of watches) await this.finishWatch(id, w, "⚠️ Контейнер зупинився, не дочекавшись завершення. Напиши уточнення, щоб продовжити.");
			return false;
		}
		if (watches.length > 0) this.listen(); // потік міг обірватись
		const oc = this.computer.opencode();
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

	// Чи є в гілки сесії відкритий PR (тоді під підсумком з'являється «Змерджити»). Якщо кнопки не буде, повертає причину для поста.
	private async pullCheck(id: string): Promise<{ ok: boolean; why?: string }> {
		const tracked = await this.store.session(id);
		const target = tracked?.repo ? { repo: tracked.repo, branch: `agent/${tracked.folder ?? id}` } : undefined;
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
		this.progress.finished(w.ocId);
		await this.posts.settled(); // проміжна правка вже в дорозі: підсумок іде після неї
		await this.posts.mark(w, false);
		if (!this.env.BOT_TOKEN) return;
		// Якщо PR сесії вже в деплої, іконку лишає стадія деплою, а не «готово»
		// Деплой PR записано на початковий пост сесії, а не на повідомлення стану ходу (воно може бути іншим).
		const sessionPost = (await this.store.session(id))?.post?.postId ?? w.postId;
		const deploy = sessionPost ? await this.storage.get<DeployInfo>(deployKey(sessionPost)) : undefined;
		await this.progress.icon(w, deploy?.stage ? DEPLOY_ICON[deploy.stage] : /^[❌⛔⚠]/u.test(text) ? "failed" : "done");
		// Підсумок успішної роботи: якщо агент відкрив PR, додаємо «Змерджити» (зупинену чи невдалу сесію не мерджимо з чату)
		const check = text.startsWith("✅") ? await this.pullCheck(id) : { ok: false };
		const mergeable = check.ok;
		if (check.why) text += `\n\nℹ️ Кнопку «Змерджити» не показано: ${check.why}.`;
		if (limit) await this.limits.wait(id, w);
		const shown = await this.posts.show(w, text, true, undefined, mergeable, limit);
		await this.progress.retitle(id, w, text);
		// Поста немає (чи його видалили): підсумок окремим повідомленням з тими самими кнопками.
		if (!shown) await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, text, w.url, limit ? "retry" : mergeable ? "mergeable" : "done", undefined, undefined, w.threadId).catch((err) => console.error("notify failed:", err));
		if (images.length > 0) await sendImages({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, images, (path) => this.computer.readImage(path), w.threadId);
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
		await this.progress.icon(full, "working");
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
		void readEvents(this.computer.opencode(), stop.signal, async (event) => {
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
		if (event.type === "form.created" && event.data?.form?.sessionID) return this.progress.ask(event.data.form);
		if (ocId && event.type === "session.tool.input.started" && event.data?.id && event.data.name) {
			this.progress.toolStarted(event.data.id, event.data.name);
			return;
		}
		if (ocId && event.type === "session.tool.called" && event.data?.id) {
			const tool = this.progress.toolCalled(ocId, event.data.id, event.data.input);
			const wanted = (tool === "bash" || tool === "shell") ? requestedMcp(event.data.input) : undefined;
			if (wanted) await this.mcp.request(ocId, wanted).catch((err) => console.error("mcp request failed:", err));
			const repo = (tool === "bash" || tool === "shell") ? settedRepo(event.data.input) : undefined;
			if (repo) await this.adoptRepo(ocId, repo).catch((err) => console.error("set-repo failed:", err));
			return this.progress.show(ocId, tool, event.data.input);
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
		const done = await this.summary(this.computer.opencode(), w);
		await this.finishWatch(id, w, done.text, done.images, done.limit);
	}

	// Агент повідомив репозиторій сесії (команда set-repo): запам'ятовуємо його, якщо на старті репозиторій не визначили.
	private async adoptRepo(ocId: string, repo: string): Promise<void> {
		const found = await this.store.sessionByOc(ocId);
		if (!found || found[1].repo) return;
		await this.store.saveSession(found[0], { ...found[1], repo });
	}

	// Повідомлення з веб-інтерфейсу в сесію, що має пост у чаті: стежимо за нею так само, як за запущеною з чату (стан, питання, підсумок
	// у пості). Повідомлення з чату йдуть повз цей проксі, тому дублів немає.
	async watchPrompted(ocId: string): Promise<void> {
		for (const [id, tracked] of await this.store.sessions()) {
			if (tracked.ocId !== ocId || !tracked.post?.chatId || !tracked.post.url) continue;
			return this.watch(id, { chatId: tracked.post.chatId, url: tracked.post.url });
		}
	}
}

import type { LimitProbe, Notices, Scheduler, SessionStore, WatchTarget } from "../../domain/agent";
import { LIMIT_POLL_MS } from "./policy";

// Сесії, що впали на лімітах підписки Claude: бот перевіряє ліміти (дешевий запит, контейнер не будить) і, коли вони скинулись, пише
// в тему кожної такої сесії. Без токена підписки перевіряти нічим, тож тоді нічого не чекаємо.
export class Limits {
	constructor(
		private readonly probe: LimitProbe,
		private readonly store: SessionStore,
		private readonly notices: Notices,
		private readonly scheduler: Scheduler,
	) {}

	// Запам'ятовує, що сесія впала на лімітах, і планує перевірку їх скидання.
	async wait(id: string, w: WatchTarget): Promise<void> {
		if (!this.probe.configured) return;
		await this.store.saveLimit(id, { chatId: w.chatId, url: w.url, threadId: w.threadId, since: Date.now() });
		await this.scheduler.noLater(Date.now() + LIMIT_POLL_MS);
	}

	// Власник уже діє (уточнення): чекати скидання лімітів заради цієї сесії не треба.
	forget(id: string): Promise<unknown> {
		return this.store.dropLimit(id);
	}

	// Перевіряє ліміти, якщо хтось чекає. Повертає, коли перевірити знову (мс від epoch), або undefined, якщо чекати нікого.
	async check(): Promise<number | undefined> {
		const waiting = await this.store.limits();
		if (waiting.length === 0) return undefined;
		if (!this.probe.configured || !this.notices.enabled) {
			for (const [id] of waiting) await this.store.dropLimit(id);
			return undefined;
		}
		const quota = await this.probe.read();
		if (!quota || quota.blocked) {
			// Ще вичерпано (чи перевірка не вдалась): наступного разу — на час скидання, але не рідше за LIMIT_POLL_MS і не пізніше за годину.
			const reset = quota?.resetAt;
			const wait = reset ? Math.min(Math.max(reset * 1000 - Date.now() + 5000, LIMIT_POLL_MS), 60 * 60 * 1000) : LIMIT_POLL_MS;
			return Date.now() + wait;
		}
		for (const [id, w] of waiting) {
			await this.store.dropLimit(id);
			await this.notices.send(id, w, "✅ Ліміти Claude скинулись. Можна повторити.", "retry").catch((err) => console.error("limit notify failed:", err));
		}
		return undefined;
	}
}

import type { WatchTarget } from "../../../domain/agent";
import type { ChatEnv, ContainerEnv } from "../../../env";
import { sendChat } from "../../chat";
import { fetchQuota, isBlocked, resetTime } from "../../quota";
import { LIMIT_POLL_MS } from "../config";
import type { SessionStore } from "../state";

// Сесії, що впали на лімітах підписки Claude: бот перевіряє ліміти (дешевий запит, контейнер не будить) і, коли вони скинулись, пише
// в тему кожної такої сесії. Без токена підписки перевіряти нічим, тож тоді нічого не чекаємо.
export class Limits {
	constructor(
		private readonly env: ChatEnv & ContainerEnv,
		private readonly store: SessionStore,
		private readonly alarmNoLater: (at: number) => Promise<void>,
	) {}

	// Запам'ятовує, що сесія впала на лімітах, і планує перевірку їх скидання.
	async wait(id: string, w: WatchTarget): Promise<void> {
		if (!this.env.CLAUDE_CODE_OAUTH_TOKEN) return;
		await this.store.saveLimit(id, { chatId: w.chatId, url: w.url, threadId: w.threadId, since: Date.now() });
		await this.alarmNoLater(Date.now() + LIMIT_POLL_MS);
	}

	// Власник уже діє (уточнення): чекати скидання лімітів заради цієї сесії не треба.
	forget(id: string): Promise<unknown> {
		return this.store.dropLimit(id);
	}

	// Перевіряє ліміти, якщо хтось чекає. Повертає, коли перевірити знову (мс від epoch), або undefined, якщо чекати нікого.
	async check(): Promise<number | undefined> {
		const waiting = await this.store.limits();
		const token = this.env.CLAUDE_CODE_OAUTH_TOKEN;
		if (waiting.length === 0) return undefined;
		if (!token || !this.env.BOT_TOKEN) {
			for (const [id] of waiting) await this.store.dropLimit(id);
			return undefined;
		}
		const quota = await fetchQuota(token).catch((err) => (console.error("quota check failed:", err), undefined));
		if (!quota || isBlocked(quota)) {
			// Ще вичерпано (чи перевірка не вдалась): наступного разу — на час скидання, але не рідше за LIMIT_POLL_MS і не пізніше за годину.
			const reset = quota && resetTime(quota);
			const wait = reset ? Math.min(Math.max(reset * 1000 - Date.now() + 5000, LIMIT_POLL_MS), 60 * 60 * 1000) : LIMIT_POLL_MS;
			return Date.now() + wait;
		}
		for (const [id, w] of waiting) {
			await this.store.dropLimit(id);
			await sendChat({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, "✅ Ліміти Claude скинулись. Можна повторити.", { id, url: w.url }, "retry", undefined, undefined, w.threadId).catch((err) => console.error("limit notify failed:", err));
		}
		return undefined;
	}
}

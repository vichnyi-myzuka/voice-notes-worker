import { workersLlm } from "@voice-notes/core";
import type { WatchTarget } from "../../domain/agent";
import type { ChatEnv, ContainerEnv } from "../../env";
import { renameTopic, setTopicIcon, type Answers, type TopicState } from "../chat";
import { describeActivity, describeForm, formChoices, formSteps } from "./activity";
import { WORKING, progressMs } from "./config";
import type { Forms } from "./forms";
import { describeCall, narrate, remember } from "./narrate";
import type { OpencodeForm } from "./opencode";
import type { Posts } from "./posts";
import type { PendingForm, Tracked, Watch } from "./state";
import type { SessionStore } from "./store";
import { retitle } from "./title";

// Службові символи, якими позначено цитату в заголовку поста: моделі вони не потрібні.
const QUOTES = /[]/g;

// Що власник бачить, поки агент працює: опис поточної дії в пості («⏳ Працює · …»), питання агента з кнопками, іконка й назва
// теми. Стан у пам'яті (після вивантаження Durable Object лише втрачається тротлінг і попередній опис).
export class Progress {
	// Назви інструментів за id виклику й час останнього оновлення поста сесії.
	private readonly toolNames = new Map<string, string>();
	private readonly lastShown = new Map<string, number>();
	// Останні дії агента (для маленької моделі, що описує поточну дію) і її попередній опис — за id сесії OpenCode.
	private readonly recent = new Map<string, string[]>();
	private readonly narration = new Map<string, string>();
	// Останнє уточнення власника за id сесії: з ним модель вирішує, чи змінився напрям розмови (назва теми).
	private readonly asks = new Map<string, string>();

	constructor(
		private readonly env: ChatEnv & ContainerEnv,
		private readonly store: SessionStore,
		private readonly posts: Posts,
		private readonly forms: Forms,
	) {}

	// Уточнення власника (для retitle).
	asked(id: string, text: string): void {
		this.asks.set(id, text);
	}

	// Хід завершився: опис дій для нього більше не потрібен.
	finished(ocId: string): void {
		this.lastShown.delete(ocId);
		this.recent.delete(ocId);
		this.narration.delete(ocId);
	}

	// Сесію видалено.
	removed(id: string): void {
		this.asks.delete(id);
	}

	// Подія «інструмент почав отримувати аргументи»: запам'ятовуємо назву, бо подія виклику її не містить.
	toolStarted(callId: string, name: string): void {
		if (this.toolNames.size > 500) this.toolNames.clear();
		this.toolNames.set(callId, name);
	}

	// Подія виклику інструмента: дія йде в історію для опису. Повертає назву інструмента ("" — невідомий).
	toolCalled(ocId: string, callId: string, input: Record<string, unknown> | undefined): string {
		const tool = this.toolNames.get(callId) ?? "";
		if (tool) this.recent.set(ocId, remember(this.recent.get(ocId) ?? [], describeCall(tool, input)));
		return tool;
	}

	// Іконка теми показує стан сесії (працює, питання, готово, збій); поза темою нічого не робить.
	async icon(w: Watch | WatchTarget, state: TopicState): Promise<void> {
		if (w.threadId && this.env.BOT_TOKEN) await setTopicIcon({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.threadId, state);
	}

	// Після ходу агента назва теми або лишається, або оновлюється, якщо напрям розмови змінився (лише для тем, створених ботом).
	// Службові повідомлення (збій, ліміт, зупинка) назву не міняють. Збій моделі чи Telegram не критичний.
	async retitle(id: string, w: Watch, result: string): Promise<void> {
		try {
			if (!result.startsWith("✅") || !w.threadId || !w.title || !this.env.BOT_TOKEN) return;
			const tracked = await this.store.session(id);
			const current = tracked?.post?.title;
			if (!tracked?.post || !current) return;
			const title = await retitle(workersLlm(this.env), current, (w.header ?? "").replace(QUOTES, ""), this.asks.get(id), result);
			if (!title || title === current) return;
			if (await renameTopic({ BOT_TOKEN: this.env.BOT_TOKEN }, w.chatId, w.threadId, title)) await this.store.saveSession(id, { ...tracked, post: { ...tracked.post, title } } satisfies Tracked);
		} catch (err) {
			console.error("retitle failed:", err);
		}
	}

	// Питання агента: текст у пост, а для простих (один вибір, так/ні) ще й кнопки-відповіді.
	async ask(form: OpencodeForm): Promise<void> {
		const entry = form.sessionID ? await this.store.watchByOc(form.sessionID) : undefined;
		if (!entry) return;
		const [id] = entry;
		const [first, ...next] = (form.id && formSteps(form)) || [];
		const found = first ?? (form.id ? formChoices(form) : undefined);
		const text = first?.text ?? describeForm(form);
		// Форму без кнопок (довільний текст) теж зберігаємо: відповідь текстом її скасує (див. followUp)
		if (form.id) await this.forms.save(id, { askedAt: Date.now(), formId: form.id, ocId: entry[1].ocId, key: found?.key ?? "", choices: found?.choices ?? [], multiple: found?.multiple, selected: [], text, next, answers: {} } satisfies PendingForm);
		await this.show(entry[1].ocId, "", undefined, text, found && { labels: found.choices.map((c) => c.label), multiple: found.multiple });
		await this.icon(entry[1], "question");
	}

	// «⏳ Працює · редагує README.md»: пост оновлюється на місці, не частіше за PROGRESS_INTERVAL_MS (проміжні дії між оновленнями пропускаються).
	// announcement: готовий текст (питання агента) замість підпису дії; показується завжди, навіть частіше за інтервал.
	async show(ocId: string, tool: string, input: Record<string, unknown> | undefined, announcement?: string, answers?: Answers): Promise<void> {
		if ((!tool && !announcement) || !this.env.BOT_TOKEN) return;
		const now = Date.now();
		if (!announcement && now - (this.lastShown.get(ocId) ?? 0) < progressMs(this.env)) return;
		const entry = await this.store.watchByOc(ocId);
		if (!entry?.[1].postId) return;
		this.lastShown.set(ocId, now);
		const w = entry[1];
		// Що відбувається, каже маленька модель за завданням і останніми діями; без неї (збій, тайм-аут) — технічний підпис.
		let activity = "";
		if (!announcement) {
			activity = (await narrate(workersLlm(this.env), (w.header ?? "").replace(QUOTES, ""), this.recent.get(ocId) ?? [], this.narration.get(ocId))) ?? "";
			if (activity) this.narration.set(ocId, activity);
		}
		const text = announcement ?? `${WORKING} · ${activity || describeActivity(tool, input)}`;
		await this.posts.enqueue(async () => {
			if (await this.store.watch(entry[0])) await this.posts.show(entry[0], w, text, false, answers); // спостереження могло закінчитись, поки чекали в черзі
		});
	}
}

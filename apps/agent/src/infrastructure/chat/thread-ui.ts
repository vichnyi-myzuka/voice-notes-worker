import { tg, type BotEnv } from "@voice-notes/core";
import type { Buttons } from "./index";

// Вигляд сесії в Telegram: єдиний інтерфейс і дві незалежні реалізації. Решта коду питає лише `ThreadUi` і не знає, який режим
// увімкнено, тож перемикання (змінна THREAD_UI, див. env.ts) не торкається логіки сесій. Новий режим — нова реалізація тут.

// Стан сесії для клавіш внизу теми: працює, завершилась, завершилась і є PR для мерджу, впала на лімітах.
export type KeyState = "working" | "done" | "mergeable" | "retry" | "approval";
export type SessionKey = "stop" | "merge" | "retry" | "del" | "approve" | "reject";
// Підписи клавіш: їх натискання надходить у тему як звичайний текст (див. interface/telegram/keys.ts).
export const KEYS: Record<SessionKey, string> = { stop: "⏹ Стоп", merge: "🔀 Змерджити", retry: "🔄 Повторити", del: "🗑 Видалити", approve: "✅ Схвалити", reject: "❌ Відхилити" };
export const keyAction = (text: string | undefined): SessionKey | undefined => (Object.keys(KEYS) as SessionKey[]).find((k) => KEYS[k] === text?.trim());

export type ThreadUi = {
	// Кнопки під постом сесії. deployDone: деплой PR завершено (лишається лише «Видалити»); mergeable: можна змерджити.
	postButtons(s: { final: boolean; retry: boolean; mergeable: boolean; deployDone: boolean }): Buttons;
	// Підсумок ходу агента: що писати в пості (post) і чи слати підсумок ще й окремим повідомленням (separate; без поста він іде завжди)
	// з якими кнопками (buttons).
	summary(s: { text: string; limit: boolean; mergeable: boolean }): { post: string; separate: boolean; buttons: Buttons };
	// Чи схвалення деплою живе в клавішах внизу теми (тоді під постом його кнопок немає).
	approvalKeys: boolean;
	// Клавіші внизу теми за станом сесії (undefined — режим їх не використовує).
	keys(state: KeyState): { label: string; keys: SessionKey[] } | undefined;
};

// Класичний вигляд: один пост, який оновлюється на місці, з кнопками керування під ним; підсумок усередині поста.
export const classicUi: ThreadUi = {
	postButtons: ({ final, retry, mergeable, deployDone }) => (deployDone ? "dismiss" : final ? (retry ? "retry" : mergeable ? "mergeable" : "done") : "working"),
	summary: ({ text, limit, mergeable }) => ({ post: text, separate: false, buttons: limit ? "retry" : mergeable ? "mergeable" : "done" }),
	approvalKeys: false,
	keys: () => undefined,
};

// Вигляд «messages»: пост лишається коротким станом без кнопок керування; керують клавіші внизу теми, які змінюються за станом
// сесії (працює — «Стоп», є PR — «Змерджити», ліміти — «Повторити»); підсумок приходить окремим повідомленням (з «Змерджити»/«Повторити»).
const STATUS = (text: string, limit: boolean) => (limit ? "⏳ Ліміти Claude вичерпано" : text.startsWith("✅") ? "✅ Готово" : text.startsWith("⏹") ? "⏹ Зупинено" : "❌ Збій");
const KEYSETS: Record<KeyState, { label: string; keys: SessionKey[] }> = {
	working: { label: "⏳ Працює", keys: ["stop", "del"] },
	done: { label: "✅ Готово", keys: ["del"] },
	mergeable: { label: "✅ Готово, можна мерджити", keys: ["merge", "del"] },
	retry: { label: "⏳ Ліміти Claude", keys: ["retry", "del"] },
	approval: { label: "🚀 Деплой чекає схвалення", keys: ["approve", "reject", "del"] },
};
export const messagesUi: ThreadUi = {
	postButtons: () => "none",
	summary: ({ text, limit, mergeable }) => ({ post: STATUS(text, limit), separate: true, buttons: limit ? "retry" : mergeable ? "mergeable" : "none" }),
	approvalKeys: true,
	keys: (state) => KEYSETS[state],
};

// Режим: прапорець `thread-ui` у Cloudflare Flagship ("classic" | "messages"; міняється в дашборді без деплою), якщо підключено
// binding FLAGS; інакше (чи при збої Flagship) змінна THREAD_UI, а за її відсутності класичний. Поза темою (канал, чат без тем) завжди класичний.
export type FlagEnv = { THREAD_UI?: string; FLAGS?: { getStringValue(key: string, fallback: string): Promise<string> } };
export async function threadUi(env: FlagEnv, inThread: boolean): Promise<ThreadUi> {
	if (!inThread) return classicUi;
	const fallback = env.THREAD_UI ?? "classic";
	const mode = env.FLAGS ? await env.FLAGS.getStringValue("thread-ui", fallback).catch((err) => (console.error("flagship failed:", err), fallback)) : fallback;
	return mode === "messages" ? messagesUi : classicUi;
}

// Показує клавіші внизу теми: Telegram міняє reply-клавіатуру лише новим повідомленням, тож шлемо коротке (з підписом стану), а
// попереднє таке повідомлення (previous) прибираємо, щоб тема не заростала. Повертає id нового повідомлення.
export async function showKeys(env: BotEnv, chat: number, thread: number, set: { label: string; keys: SessionKey[] }, previous?: number): Promise<number | undefined> {
	try {
		const sent = await tg(env, "sendMessage", { chat_id: chat, message_thread_id: thread, text: set.label, reply_markup: { keyboard: [set.keys.map((k) => ({ text: KEYS[k] }))], resize_keyboard: true, is_persistent: true } } as never);
		if (previous) await tg(env, "deleteMessage", { chat_id: chat, message_id: previous }).catch(() => {});
		return sent.message_id;
	} catch (err) {
		console.error("session keys failed:", err);
		return previous;
	}
}

import { tg, type BotEnv } from "@voice-notes/core";
import type { Buttons } from "./index";

// Текст кнопки постійної клавіатури внизу теми: її натискання надходить як звичайний текст.
export const MENU_BUTTON = "⚙️ Меню сесії";

// Постійна клавіатура внизу теми з однією кнопкою «⚙️ Меню сесії» (як «Головне меню» в інших ботів). Повідомлення потрібне Telegram,
// щоб показати клавіатуру; воно коротке й лишається в темі.
async function sendMenuKeyboard(env: BotEnv, chatId: number, threadId: number): Promise<void> {
	await tg(env, "sendMessage", { chat_id: chatId, message_thread_id: threadId, text: `Керування сесією: кнопка «${MENU_BUTTON}» внизу.`, reply_markup: { keyboard: [[{ text: MENU_BUTTON }]], resize_keyboard: true, is_persistent: true } } as never).catch((err) => console.error("menu keyboard failed:", err));
}

// Вигляд сесії в Telegram: єдиний інтерфейс і дві незалежні реалізації. Решта коду питає лише `ThreadUi` і не знає, який режим
// увімкнено, тож перемикання (змінна THREAD_UI, див. env.ts) не торкається логіки сесій. Новий режим — нова реалізація тут.
export type ThreadUi = {
	// Кнопки під постом сесії. deployDone: деплой PR завершено (лишається лише «Видалити»); mergeable: можна змерджити.
	postButtons(s: { final: boolean; retry: boolean; mergeable: boolean; deployDone: boolean }): Buttons;
	// Підсумок ходу агента: що писати в пості (post) і чи слати підсумок ще й окремим повідомленням (separate; без поста він іде завжди)
	// з якими кнопками (buttons).
	summary(s: { text: string; limit: boolean; mergeable: boolean }): { post: string; separate: boolean; buttons: Buttons };
	// Тему для сесії щойно створив бот.
	topicCreated(env: BotEnv, chat: number, thread: number): Promise<void>;
};

// Класичний вигляд: один пост, який оновлюється на місці, з кнопками керування під ним; підсумок усередині поста.
export const classicUi: ThreadUi = {
	postButtons: ({ final, retry, mergeable, deployDone }) => (deployDone ? "dismiss" : final ? (retry ? "retry" : mergeable ? "mergeable" : "done") : "working"),
	summary: ({ text, limit, mergeable }) => ({ post: text, separate: false, buttons: limit ? "retry" : mergeable ? "mergeable" : "done" }),
	topicCreated: async () => {},
};

// Вигляд «messages»: пост лишається коротким станом без кнопок керування, нею керує кнопка «⚙️ Меню сесії» внизу теми,
// а підсумок приходить окремим повідомленням (з «Змерджити»/«Повторити», коли це доречно).
const STATUS = (text: string, limit: boolean) => (limit ? "⏳ Ліміти Claude вичерпано" : text.startsWith("✅") ? "✅ Готово" : text.startsWith("⏹") ? "⏹ Зупинено" : "❌ Збій");
export const messagesUi: ThreadUi = {
	postButtons: () => "none",
	summary: ({ text, limit, mergeable }) => ({ post: STATUS(text, limit), separate: true, buttons: limit ? "retry" : mergeable ? "mergeable" : "none" }),
	topicCreated: (env, chat, thread) => sendMenuKeyboard(env, chat, thread),
};

// Режим за змінною THREAD_UI; поза темою (канал, чат без тем) завжди класичний.
export const threadUi = (env: { THREAD_UI?: string }, inThread: boolean): ThreadUi => (env.THREAD_UI === "messages" && inThread ? messagesUi : classicUi);

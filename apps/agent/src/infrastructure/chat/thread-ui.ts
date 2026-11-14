import { tg, type BotEnv } from "@voice-notes/core";
import type { Buttons } from "./index";

// Вигляд сесії в Telegram: єдиний інтерфейс і дві незалежні реалізації. Решта коду питає лише `ThreadUi` і не знає, який режим
// увімкнено, тож перемикання (змінна THREAD_UI, див. env.ts) не торкається логіки сесій. Новий режим — нова реалізація тут.

// Стан сесії для клавіш внизу теми: працює, завершилась, завершилась і є PR для мерджу, впала на лімітах.
export type KeyState = "working" | "done" | "mergeable" | "retry" | "approval";
export type SessionKey = "stop" | "merge" | "retry" | "del" | "approve" | "reject" | "commands" | "back" | "quota" | "status" | "update";
// Рядки клавіш одного набору.
export type KeySet = { label: string; keys: SessionKey[][] };
export type KeyView = "session" | "commands";
// Підписи клавіш: їх натискання надходить у тему як звичайний текст (див. interface/telegram/keys.ts).
export const KEYS: Record<SessionKey, string> = { stop: "⏹ Стоп", merge: "🔀 Змерджити", retry: "🔄 Повторити", del: "🗑 Видалити", approve: "✅ Схвалити", reject: "❌ Відхилити", commands: "⚙️ Команди", back: "← Назад", quota: "📊 Ліміти", status: "ℹ️ Стан", update: "🔄 Оновити контейнер" };
export const keyAction = (text: string | undefined): SessionKey | undefined => (Object.keys(KEYS) as SessionKey[]).find((k) => KEYS[k] === text?.trim());

export type ThreadUi = {
	// Кнопки під постом сесії. deployDone: деплой PR завершено (лишається лише «Видалити»); mergeable: можна змерджити.
	postButtons(s: { final: boolean; retry: boolean; mergeable: boolean; deployDone: boolean }): Buttons;
	// Підсумок ходу агента: що писати в пості (post) і чи слати підсумок ще й окремим повідомленням (separate; без поста він іде завжди)
	// з якими кнопками (buttons).
	// message — текст окремого повідомлення (у «messages» без повтору «✅ Готово», яке вже є в повідомленні стану).
	summary(s: { text: string; limit: boolean; mergeable: boolean }): { post: string; message: string; separate: boolean; buttons: Buttons };
	// Чи кожен хід агента після уточнення починається новим повідомленням зі станом (воно оновлюється до підсумку), а не редагує початковий пост.
	statusPerTurn: boolean;
	// Чи лишати в темі повідомлення-уточнення власника (історія розмови), а не видаляти їх після прийняття.
	keepFollowUps: boolean;
	// Чи сесії створюються лише в темах: у головному чаті текст сесії не починає, а кнопка «➕ Нова сесія» відкриває порожню тему,
	// де перше повідомлення стартує сесію й перейменовує тему (запис із Shortcut створює тему й сесію сам).
	topicOnlyStart: boolean;
	// Чи схвалення деплою живе в клавішах внизу теми (тоді під постом його кнопок немає).
	approvalKeys: boolean;
	// Клавіші внизу теми за станом сесії (undefined — режим їх не використовує).
	keys(state: KeyState): KeySet | undefined;
	// Екран загальних команд (кнопка «⚙️ Команди»): ліміти, стан, оновлення контейнера й «← Назад» до дій сесії.
	commands(): KeySet | undefined;
};

// Класичний вигляд: один пост, який оновлюється на місці, з кнопками керування під ним; підсумок усередині поста.
export const classicUi: ThreadUi = {
	postButtons: ({ final, retry, mergeable, deployDone }) => (deployDone ? "dismiss" : final ? (retry ? "retry" : mergeable ? "mergeable" : "done") : "working"),
	summary: ({ text, limit, mergeable }) => ({ post: text, message: text, separate: false, buttons: limit ? "retry" : mergeable ? "mergeable" : "done" }),
	statusPerTurn: false,
	keepFollowUps: false,
	topicOnlyStart: false,
	approvalKeys: false,
	keys: () => undefined,
	commands: () => undefined,
};

// Вигляд «messages»: пост лишається коротким станом без кнопок керування; керують клавіші внизу теми, які змінюються за станом
// сесії (працює — «Стоп», є PR — «Змерджити», ліміти — «Повторити»); підсумок приходить окремим повідомленням (з «Змерджити»/«Повторити»).
const STATUS = (text: string, limit: boolean) => (limit ? "⏳ Ліміти Claude вичерпано" : text.startsWith("✅") ? "✅ Готово" : text.startsWith("⏹") ? "⏹ Зупинено" : "❌ Збій");
const MORE: SessionKey[] = ["commands"];
const KEYSETS: Record<KeyState, KeySet> = {
	working: { label: "⏳ Працює", keys: [["stop", "del"], MORE] },
	done: { label: "✅ Готово", keys: [["del"], MORE] },
	mergeable: { label: "✅ Готово, можна мерджити", keys: [["merge", "del"], MORE] },
	retry: { label: "⏳ Ліміти Claude", keys: [["retry", "del"], MORE] },
	approval: { label: "🚀 Деплой чекає схвалення", keys: [["approve", "reject", "del"], MORE] },
};
const COMMANDS_SET: KeySet = { label: "⚙️ Команди", keys: [["quota", "status"], ["update"], ["back"]] };
export const messagesUi: ThreadUi = {
	postButtons: () => "none",
	// Без кнопок під підсумком: «Змерджити» й «Повторити» уже є в клавішах внизу теми, які прикріплюються до цього повідомлення.
	summary: ({ text, limit }) => ({ post: STATUS(text, limit), message: text.replace(/^✅ Готово\n\n(?=\S)/, ""), separate: true, buttons: "none" }),
	statusPerTurn: true,
	keepFollowUps: true,
	topicOnlyStart: true,
	approvalKeys: true,
	keys: (state) => KEYSETS[state],
	commands: () => COMMANDS_SET,
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

// Кнопка постійної клавіатури головного чату: відкриває нову порожню тему під сесію.
export const NEW_SESSION = "➕ Нова сесія";
export async function sendNewSessionKeyboard(env: BotEnv, chat: number, text: string): Promise<void> {
	await tg(env, "sendMessage", { chat_id: chat, text, reply_markup: { keyboard: [[{ text: NEW_SESSION }]], resize_keyboard: true, is_persistent: true } } as never).catch((err) => console.error("new session keyboard failed:", err));
}

// Показує клавіші внизу теми: Telegram міняє reply-клавіатуру лише новим повідомленням, тож шлемо коротке (з підписом стану), а
// попереднє таке повідомлення (previous) прибираємо, щоб тема не заростала. Повертає id нового повідомлення.
// Клавіатура внизу теми для набору клавіш. Telegram міняє її лише разом із новим повідомленням, тож її краще чіпляти до
// повідомлення зі станом, яке й так надсилається (sendChat, параметр keys), а окремий showKeys лишити на випадок, коли такого немає.
export const replyKeyboard = (set: KeySet) => ({ keyboard: set.keys.map((row) => row.map((k) => ({ text: KEYS[k] }))), resize_keyboard: true, is_persistent: true });

export async function showKeys(env: BotEnv, chat: number, thread: number, set: KeySet, previous?: number): Promise<number | undefined> {
	try {
		const sent = await tg(env, "sendMessage", { chat_id: chat, message_thread_id: thread, text: set.label, reply_markup: replyKeyboard(set) } as never);
		if (previous) await tg(env, "deleteMessage", { chat_id: chat, message_id: previous }).catch(() => {});
		return sent.message_id;
	} catch (err) {
		console.error("session keys failed:", err);
		return previous;
	}
}

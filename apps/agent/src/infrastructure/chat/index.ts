import { NO_PREVIEW, tg, type BotEnv, type TgInlineKeyboard } from "@voice-notes/core";
import { chatHtml, escapeHtml, stripQuote, tablesToCards } from "@voice-notes/telegram-format";
import { callback } from "./callback";

export { QUOTE_CLOSE, QUOTE_OPEN, chatHtml } from "@voice-notes/telegram-format";
export { callback, parseCallback, type Callback, type SessionAction } from "./callback";
export { EPHEMERAL_MARK, EPHEMERAL_MS, createTopic, removeMessage, removeTopic, renameTopic, removeOriginal, sayTemporarily, setTopicIcon, type TopicState } from "./messages";

// Кнопки під постом сесії: поки агент працює — «Стоп» і «Видалити», після завершення — лише «Видалити». Id сесії береться з її
// посилання (…/s/<id>), у callback_data лежить `<дія>:<id>` (обробляє interface/telegram). Редагування без reply_markup кнопки
// прибирає, тому їх передає кожен виклик sendChat/editChat.
// "mergeable": сесія завершена, а в її гілки є відкритий PR: додається «Змерджити» (`merge:<id>`).
// "dismiss": деплой завершено, сесію прибрано: лишається лише «Видалити» (просте видалення повідомлення, `dismiss`).
export type Buttons = "working" | "done" | "mergeable" | "dismiss";
// Запит на схвалення деплою в пості сесії: кнопки «Схвалити/Відхилити» (`appr|rej:<repo>:<id запуску>`, обробляє interface/github/review).
export type Review = { repo: string; runId: number };
// Кнопки-відповіді на питання агента: підписи (для множинного вибору з позначками) й режим: одразу відповісти чи перемикати + «Підтвердити».
export type Answers = { labels: string[]; multiple?: boolean };
const SESSION_ID = /\/s\/(tg-[\w-]+)/;
function keyboard(sessionUrl: string | undefined, buttons: Buttons | undefined, answers?: Answers, review?: Review): TgInlineKeyboard | undefined {
	const id = sessionUrl && buttons ? SESSION_ID.exec(sessionUrl)?.[1] : undefined;
	if (!id) return undefined;
	const row = [
		...(buttons === "working" ? [{ text: "⏹ Стоп", callback_data: callback.stop(id) }] : []),
		...(buttons === "mergeable" ? [{ text: "🔀 Змерджити", callback_data: callback.merge(id) }] : []),
		{ text: "🗑 Видалити", callback_data: buttons === "dismiss" ? callback.dismiss : callback.del(id) },
	];
	const approval = review ? [[{ text: "✅ Схвалити", callback_data: callback.approve(review.repo, review.runId) }, { text: "❌ Відхилити", callback_data: callback.reject(review.repo, review.runId) }]] : [];
	// Варіанти відповіді на питання агента: по кнопці в рядку над службовими (callback_data `ans:<id>:<номер варіанта>`)
	const choices = (answers?.labels ?? []).map((label, i) => [{ text: label.length > 32 ? `${label.slice(0, 31)}…` : label, callback_data: answers?.multiple ? callback.toggle(id, i) : callback.answer(id, i) }]);
	const confirm = answers?.multiple ? [[{ text: "✅ Підтвердити", callback_data: callback.confirm(id) }]] : [];
	return { inline_keyboard: [...choices, ...confirm, ...approval, row] };
}

// Текст повідомлення в двох видах: HTML і простий (запасний, якщо Telegram відхилить розмітку). Внизу, за потреби,
// посилання на сесію («🔗 Відкрити сесію»).
function render(text: string, sessionUrl?: string): { html: string; plain: string } {
	const tail = (html: boolean) => (sessionUrl ? `${text ? "\n\n" : ""}🔗 ${html ? `<a href="${escapeHtml(sessionUrl)}">Відкрити сесію</a>` : sessionUrl}` : "");
	return { html: `${chatHtml(text)}${tail(true)}`, plain: `${stripQuote(tablesToCards(text))}${tail(false)}` };
}

// Надсилає повідомлення з форматуванням і необов'язковим посиланням на сесію внизу. Якщо Telegram відхилив розмітку, шле
// той самий текст без неї. Повертає message_id.
export async function sendChat(env: BotEnv, chatId: number | string, text: string, sessionUrl?: string, buttons?: Buttons, answers?: Answers, review?: Review, threadId?: number): Promise<number> {
	const { html, plain } = render(text, sessionUrl);
	const reply_markup = keyboard(sessionUrl, buttons, answers, review);
	const thread = threadId ? { message_thread_id: threadId } : {};
	try {
		return (await tg(env, "sendMessage", { chat_id: chatId, ...thread, text: html, parse_mode: "HTML", link_preview_options: NO_PREVIEW, reply_markup })).message_id;
	} catch (err) {
		console.error("html message rejected, sending plain:", err);
		return (await tg(env, "sendMessage", { chat_id: chatId, ...thread, text: plain, link_preview_options: NO_PREVIEW, reply_markup })).message_id;
	}
}

// Редагує повідомлення на місці (так само: HTML, потім простий текст). «Не змінилось» — не помилка. false — не вдалося
// (повідомлення видалили чи надто довге): викликач може надіслати нове.
export async function editChat(env: BotEnv, chatId: number | string, messageId: number, text: string, sessionUrl?: string, buttons?: Buttons, answers?: Answers, review?: Review): Promise<boolean> {
	const { html, plain } = render(text, sessionUrl);
	const reply_markup = keyboard(sessionUrl, buttons, answers, review);
	const edit = async (body: string, parse_mode?: "HTML") => {
		try {
			await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: body, ...(parse_mode && { parse_mode }), link_preview_options: NO_PREVIEW, reply_markup });
			return true;
		} catch (err) {
			if (String(err).includes("message is not modified")) return true;
			throw err;
		}
	};
	try {
		return await edit(html, "HTML");
	} catch (err) {
		console.error("html edit rejected, editing plain:", err);
		return edit(plain).catch((e) => (console.error("edit failed:", e), false));
	}
}

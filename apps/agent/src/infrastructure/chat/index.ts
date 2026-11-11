import { tg, type BotEnv, type TgInlineKeyboard } from "@voice-notes/core";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Короткий підпис для посилання: GitHub PR/issue → `owner/repo#13`, решта — адреса без протоколу, слеша й надто довгого хвоста.
function label(url: string): string {
	const gh = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(url);
	if (gh) return `${gh[1]}#${gh[2]}`;
	const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

// Текст агента (звичайний Markdown) → HTML Telegram: **жирний**, `код`, [текст](url), заголовки, списки; голі URL стають
// клікабельними з коротким підписом. Усе інше екранується, тож HTML від моделі не потрапляє в розмітку.
export function chatHtml(text: string): string {
	return escape(text)
		.split(/(`[^`\n]+`)/)
		.map((part, i) => {
			if (i % 2) return `<code>${part.slice(1, -1)}</code>`;
			const marked = part
				.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
				.replace(/^(\s*)[-*]\s+/gm, "$1• ")
				.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
				.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
			// Голі URL: уже готові <a>…</a> пропускаємо; крапка чи кома в кінці речення до адреси не належить.
			return marked.replace(/(<a href="[^"]*">[^<]*<\/a>)|(https?:\/\/[^\s<>"]+)/g, (m, anchor: string | undefined, url: string | undefined) => {
				if (anchor || !url) return m;
				const clean = url.replace(/[.,;:!?)]+$/, "");
				return `<a href="${clean}">${escape(label(clean.replace(/&amp;/g, "&")))}</a>${url.slice(clean.length)}`;
			});
		})
		.join("");
}

const NO_PREVIEW = { is_disabled: true }; // без карток сторінок (вони за Access)

// Кнопки під постом сесії: поки агент працює — «Стоп» і «Видалити», після завершення — лише «Видалити». Id сесії береться з її
// посилання (…/s/<id>), у callback_data лежить `<дія>:<id>` (обробляє interface/telegram). Редагування без reply_markup кнопки
// прибирає, тому їх передає кожен виклик sendChat/editChat.
export type Buttons = "working" | "done";
// Кнопки-відповіді на питання агента: підписи (для множинного вибору з позначками) й режим: одразу відповісти чи перемикати + «Підтвердити».
export type Answers = { labels: string[]; multiple?: boolean };
const SESSION_ID = /\/s\/(tg-[\w-]+)/;
function keyboard(sessionUrl: string | undefined, buttons: Buttons | undefined, answers?: Answers): TgInlineKeyboard | undefined {
	const id = sessionUrl && buttons ? SESSION_ID.exec(sessionUrl)?.[1] : undefined;
	if (!id) return undefined;
	const row = [...(buttons === "working" ? [{ text: "⏹ Стоп", callback_data: `stop:${id}` }] : []), { text: "🗑 Видалити", callback_data: `del:${id}` }];
	// Варіанти відповіді на питання агента: по кнопці в рядку над службовими (callback_data `ans:<id>:<номер варіанта>`)
	const action = answers?.multiple ? "tog" : "ans";
	const choices = (answers?.labels ?? []).map((label, i) => [{ text: label.length > 32 ? `${label.slice(0, 31)}…` : label, callback_data: `${action}:${id}:${i}` }]);
	const confirm = answers?.multiple ? [[{ text: "✅ Підтвердити", callback_data: `ok:${id}` }]] : [];
	return { inline_keyboard: [...choices, ...confirm, row] };
}

// Текст повідомлення в двох видах: HTML і простий (запасний, якщо Telegram відхилить розмітку). Внизу, за потреби,
// посилання на сесію («🔗 Відкрити сесію»).
function render(text: string, sessionUrl?: string): { html: string; plain: string } {
	const tail = (html: boolean) => (sessionUrl ? `${text ? "\n\n" : ""}🔗 ${html ? `<a href="${escape(sessionUrl)}">Відкрити сесію</a>` : sessionUrl}` : "");
	return { html: `${chatHtml(text)}${tail(true)}`, plain: `${text}${tail(false)}` };
}

// Надсилає повідомлення з форматуванням і необов'язковим посиланням на сесію внизу. Якщо Telegram відхилив розмітку, шле
// той самий текст без неї. Повертає message_id.
export async function sendChat(env: BotEnv, chatId: number | string, text: string, sessionUrl?: string, buttons?: Buttons, answers?: Answers): Promise<number> {
	const { html, plain } = render(text, sessionUrl);
	const reply_markup = keyboard(sessionUrl, buttons, answers);
	try {
		return (await tg(env, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: NO_PREVIEW, reply_markup })).message_id;
	} catch (err) {
		console.error("html message rejected, sending plain:", err);
		return (await tg(env, "sendMessage", { chat_id: chatId, text: plain, link_preview_options: NO_PREVIEW, reply_markup })).message_id;
	}
}

// Редагує повідомлення на місці (так само: HTML, потім простий текст). «Не змінилось» — не помилка. false — не вдалося
// (повідомлення видалили чи надто довге): викликач може надіслати нове.
export async function editChat(env: BotEnv, chatId: number | string, messageId: number, text: string, sessionUrl?: string, buttons?: Buttons, answers?: Answers): Promise<boolean> {
	const { html, plain } = render(text, sessionUrl);
	const reply_markup = keyboard(sessionUrl, buttons, answers);
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

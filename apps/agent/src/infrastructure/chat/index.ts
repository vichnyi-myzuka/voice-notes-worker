import { tg, type BotEnv } from "@voice-notes/core";

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

// Надсилає повідомлення з форматуванням і необов'язковим посиланням на сесію внизу («🔗 Відкрити сесію»). Без прев'ю карток
// (сторінка за Access). Якщо Telegram відхилив розмітку, шле той самий текст без неї. Повертає message_id.
export async function sendChat(env: BotEnv, chatId: number | string, text: string, sessionUrl?: string): Promise<number> {
	const html = `${chatHtml(text)}${sessionUrl ? `${text ? "\n\n" : ""}🔗 <a href="${escape(sessionUrl)}">Відкрити сесію</a>` : ""}`;
	const link_preview_options = { is_disabled: true };
	try {
		return (await tg(env, "sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options })).message_id;
	} catch (err) {
		console.error("html message rejected, sending plain:", err);
		return (await tg(env, "sendMessage", { chat_id: chatId, text: `${text}${sessionUrl ? `\n\n🔗 ${sessionUrl}` : ""}`, link_preview_options })).message_id;
	}
}

// Markdown від агента → HTML для Telegram (parse_mode HTML). Чиста логіка без мережі: пакет не залежить ні від ботів, ні від агента.
import { tablesToCards } from "./tables";

export { tablesToCards };

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Короткий підпис для посилання: GitHub PR/issue → `owner/repo#13`, решта — адреса без протоколу, слеша й надто довгого хвоста.
function label(url: string): string {
	const gh = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(url);
	if (gh) return `${gh[1]}#${gh[2]}`;
	const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

// Текст агента (звичайний Markdown) → HTML Telegram: **жирний**, `код`, [текст](url), заголовки, списки; голі URL стають
// клікабельними з коротким підписом; таблиці (їх Telegram не вміє) стають списками-картками (див. tables.ts).
// Усе інше екранується, тож HTML від моделі не потрапляє в розмітку.
export function chatHtml(text: string): string {
	// Фрагменти між QUOTE_OPEN і QUOTE_CLOSE — згорнута цитата (розшифровка голосового); решта — звичайний текст.
	return tablesToCards(text)
		.split(/\uE000([^\uE001]*)\uE001/)
		.map((part, i) => (i % 2 ? `<blockquote expandable>${inline(part)}</blockquote>` : inline(part)))
		.join("");
}

// Маркери згорнутої цитати в тексті шапки (символи приватної зони Unicode, у тексті агента не трапляються).
export const QUOTE_OPEN = "\uE000";
export const QUOTE_CLOSE = "\uE001";
export const stripQuote = (s: string) => s.replace(/[\uE000\uE001]/g, "");

function inline(text: string): string {
	return escapeHtml(text)
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
				return `<a href="${clean}">${escapeHtml(label(clean.replace(/&amp;/g, "&")))}</a>${url.slice(clean.length)}`;
			});
		})
		.join("");
}


import { describe, expect, it } from "vitest";
import { QUOTE_CLOSE, QUOTE_OPEN, chatHtml } from "../src";

describe("chatHtml: таблиці", () => {
	const table = "| Проєкт | ★ | Мова |\n|---|---|---|\n| a/b | 3513 | Python |\n| c/d | 12 | Go |";

	it("широка таблиця стає картками: перша колонка жирним, решта «Колонка: значення»", () => {
		expect(chatHtml(`Ось:\n\n${table}\n\nГотово.`)).toBe("Ось:\n\n<b>a/b</b>\n• ★: 3513\n• Мова: Python\n\n<b>c/d</b>\n• ★: 12\n• Мова: Go\n\nГотово.");
	});

	it("двоколонкова — рядки «• жирне — значення»; порожні клітинки й вирівнювання (:---:) не заважають", () => {
		expect(chatHtml("| Ключ | Значення |\n| :--- | ---: |\n| a | 1 |\n| b |  |")).toBe("• <b>a</b> — 1\n• <b>b</b>");
	});

	it("клітинки зберігають код, посилання й екранування; `\\|` — символ, а не межа", () => {
		expect(chatHtml("| Назва | Опис |\n|---|---|\n| **x** | `a<b` і [л](https://e.com) a\\|b |")).toBe('• <b>x</b> — <code>a&lt;b</code> і <a href="https://e.com">л</a> a|b');
	});

	it("таблиця без обрамлювальних `|` і впритул до тексту відділяється порожнім рядком", () => {
		expect(chatHtml("Текст\nА | Б\n--|--\n1 | 2")).toBe("Текст\n\n• <b>1</b> — 2");
	});

	it("у блоці коду таблиця лишається як є; звичайний текст з `|` не чіпається", () => {
		const code = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
		expect(chatHtml(code)).toContain("|---|---|");
		expect(chatHtml("a | b і c | d")).toBe("a | b і c | d");
	});
});

describe("chatHtml", () => {
	it("голі посилання стають клікабельними з коротким підписом; GitHub PR — owner/repo#N", () => {
		expect(chatHtml("PR: https://github.com/me/app/pull/13.")).toBe('PR: <a href="https://github.com/me/app/pull/13">me/app#13</a>.');
		expect(chatHtml("див. https://sites.example.com/hello-test/ (ось)")).toBe('див. <a href="https://sites.example.com/hello-test/">sites.example.com/hello-test</a> (ось)');
		expect(chatHtml("https://a.dev/x?a=1&b=2")).toBe('<a href="https://a.dev/x?a=1&amp;b=2">a.dev/x?a=1&amp;b=2</a>');
		expect(chatHtml(`https://example.com/${"x".repeat(80)}`)).toContain("…</a>");
	});

	it("Markdown агента: **жирний**, `код`, [текст](url), заголовки й списки; код не чіпається", () => {
		expect(chatHtml("**Готово**: `npm run check` і [PR](https://github.com/me/app/pull/1)")).toBe('<b>Готово</b>: <code>npm run check</code> і <a href="https://github.com/me/app/pull/1">PR</a>');
		expect(chatHtml("## Зміни\n- один\n* два")).toBe("<b>Зміни</b>\n• один\n• два");
		expect(chatHtml("- **`handle.ts`**: у main")).toBe("• <b><code>handle.ts</code></b>: у main");
		expect(chatHtml("`**не жирний** https://x.dev`")).toBe("<code>**не жирний** https://x.dev</code>");
	});

	it("текст між маркерами цитати стає згорнутою цитатою, решта форматується як зазвичай", () => {
		expect(chatHtml(`📦 me/app\n\n${QUOTE_OPEN}🗣 зроби <b> & **це**${QUOTE_CLOSE}\n\n⏳ Працює`)).toBe("📦 me/app\n\n<blockquote expandable>🗣 зроби &lt;b&gt; &amp; <b>це</b></blockquote>\n\n⏳ Працює");
	});

	it("HTML від моделі екранується", () => {
		expect(chatHtml("<script>alert(1)</script> & <b>x</b>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;");
	});
});

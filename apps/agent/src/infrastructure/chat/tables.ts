// Markdown-таблиці в Telegram не працюють (немає тегів таблиці, а `<pre>` на телефоні ламається на широких), тому перед
// відправкою вони стають списками-картками. Працює над сирим Markdown: далі його екранує й розмічає `chatHtml`.
//
//   | Проєкт | Зірки | Мова |        **taylorwilsdon/gws**
//   |---|---|---|          →        • Зірки: 3513
//   | taylorwilsdon/gws | 3513 | Python |   • Мова: Python
//
// Дві колонки стають рядками `• **перша** — друга`. Порожні клітинки пропускаються. Таблиці всередині блоків коду не чіпаються.

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

// Клітинки рядка таблиці: без крайніх `|`, `\|` лишається символом, пробіли обрізані.
function cells(line: string): string[] {
	const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const plain = (s: string) => s.replace(/\*\*/g, "").trim();

function card(headers: string[], rows: string[][]): string[] {
	if (headers.length === 2) return rows.map(([a, b]) => `• ${a ? `**${plain(a)}**` : ""}${a && b ? " — " : ""}${b ?? ""}`.trimEnd());
	return rows.map((row, n) => {
		const [title, ...rest] = row;
		const lines = rest.flatMap((value, i) => (value ? [`• ${headers[i + 1] ? `${plain(headers[i + 1])}: ` : ""}${value}`] : []));
		return [...(n ? [""] : []), ...(title ? [`**${plain(title)}**`] : []), ...lines].join("\n");
	});
}

export function tablesToCards(text: string): string {
	if (!text.includes("|")) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE.test(line)) fenced = !fenced;
		const isTable = !fenced && line.includes("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]);
		if (!isTable) {
			out.push(line);
			continue;
		}
		const headers = cells(line);
		const rows: string[][] = [];
		let j = i + 2;
		for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) {
			const row = cells(lines[j]);
			rows.push(headers.map((_, k) => row[k] ?? ""));
		}
		// Таблиця з однією колонкою чи без рядків лишається як є (виглядає як звичайний текст).
		if (headers.length < 2 || !rows.length) {
			out.push(line);
			continue;
		}
		if (out.length && out[out.length - 1].trim()) out.push("");
		out.push(...card(headers, rows).join("\n").split("\n"));
		i = j - 1;
	}
	return out.join("\n");
}

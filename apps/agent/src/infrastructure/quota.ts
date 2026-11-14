// Ліміти підписки Claude. Окремого публічного API немає, але кожна відповідь /v1/messages з токеном підписки несе
// заголовки anthropic-ratelimit-unified-*: відсоток використання 5-годинного і тижневого вікон та час їх скидання.
// Тому робимо найменший можливий запит (haiku, 1 токен) і читаємо лише заголовки.

export type Window = { utilization: number; resetAt?: number }; // utilization 0..1, resetAt — unix-секунди
export type Quota = { fiveHour?: Window; sevenDay?: Window; status?: string };

export async function fetchQuota(token: string): Promise<Quota> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-haiku-5-5",
			max_tokens: 1,
			system: "You are Claude Code, Anthropic's official CLI for Claude.", // без цього токен підписки відхиляється
			messages: [{ role: "user", content: "hi" }],
		}),
	});
	const quota = parseQuota(res.headers);
	// 429 теж несе заголовки (саме тоді ліміт вичерпано); інші помилки без заголовків — збій.
	if (!quota.fiveHour && !quota.sevenDay) throw new Error(`quota ${res.status}`);
	return quota;
}

export function parseQuota(headers: Headers): Quota {
	const win = (name: string): Window | undefined => {
		const raw = headers.get(`anthropic-ratelimit-unified-${name}-utilization`);
		if (!raw || !Number.isFinite(Number(raw))) return undefined;
		const reset = Number(headers.get(`anthropic-ratelimit-unified-${name}-reset`));
		return { utilization: Number(raw), ...(reset > 0 && { resetAt: reset }) };
	};
	return { fiveHour: win("5h"), sevenDay: win("7d"), status: headers.get("anthropic-ratelimit-unified-status") ?? undefined };
}

// Чи схожа помилка моделі на вичерпані ліміти підписки (а не на збій завдання).
export function isLimitError(error: string): boolean {
	return /usage limit|hit your limit|limit reached|rate[ _-]?limit|\b429\b|exceeded.*(quota|limit)/i.test(error);
}

// Ліміти вичерпано зараз: статус «rejected» або одне з вікон заповнене.
export function isBlocked(q: Quota): boolean {
	return q.status === "rejected" || [q.fiveHour, q.sevenDay].some((w) => w && w.utilization >= 1);
}

// Коли ліміти скинуться (unix-секунди): найпізніше скидання серед заповнених вікон.
export function resetTime(q: Quota): number | undefined {
	const times = [q.fiveHour, q.sevenDay].filter((w) => w && w.utilization >= 1 && w.resetAt).map((w) => w!.resetAt!);
	return times.length ? Math.max(...times) : undefined;
}

const BAR_CELLS = 20; // одна клітинка = 5%

// Смужка заповнення: «██████████████░░░░░░» (63% → 13 клітинок із 20, округлення до найближчої).
export function progressBar(utilization: number): string {
	const filled = Math.round(Math.min(1, Math.max(0, utilization)) * BAR_CELLS);
	return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

// Текст для людини: назва вікна, смужка з відсотком і час до скидання.
export function describeQuota(q: Quota, now = Date.now()): string {
	const block = (label: string, w?: Window) => {
		if (!w) return "";
		const left = w.resetAt ? Math.max(0, w.resetAt * 1000 - now) : undefined;
		return `${label}\n${progressBar(w.utilization)} ${Math.round(w.utilization * 100)}%${left === undefined ? "" : `\nскидання через ${duration(left)}`}`;
	};
	const blocked = q.status && q.status !== "allowed" ? "\n\n⛔ Ліміт вичерпано." : "";
	return `📊 Ліміти Claude\n\n${[block("5 годин", q.fiveHour), block("Тиждень", q.sevenDay)].filter(Boolean).join("\n\n")}${blocked}`;
}

function duration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60000));
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;
	return [d && `${d} дн`, h && `${h} год`, !d && m && `${m} хв`].filter(Boolean).join(" ");
}

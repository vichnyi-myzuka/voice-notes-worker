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

// Текст для людини: «5 годин: 63% (скидання через 2 год 10 хв)».
export function describeQuota(q: Quota, now = Date.now()): string {
	const line = (label: string, w?: Window) => {
		if (!w) return "";
		const left = w.resetAt ? Math.max(0, w.resetAt * 1000 - now) : undefined;
		return `${label}: ${Math.round(w.utilization * 100)}%${left === undefined ? "" : ` (скидання через ${duration(left)})`}`;
	};
	const blocked = q.status && q.status !== "allowed" ? "\n⛔ Ліміт вичерпано." : "";
	return `📊 Ліміти Claude\n${[line("5 годин", q.fiveHour), line("Тиждень", q.sevenDay)].filter(Boolean).join("\n")}${blocked}`;
}

function duration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60000));
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;
	return [d && `${d} дн`, h && `${h} год`, !d && m && `${m} хв`].filter(Boolean).join(" ");
}

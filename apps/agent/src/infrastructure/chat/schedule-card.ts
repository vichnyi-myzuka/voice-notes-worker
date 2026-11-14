import type { TgInlineKeyboard } from "@voice-notes/core";
import { DEFAULT_TZ, type Schedule } from "../../domain/schedule";
import { callback } from "./callback";

const STATUS = { pending: "⏳ чекає підтвердження", active: "🟢 активна", paused: "⏸ на паузі", done: "✔️ завершена" } as const;
const RESULT = { ok: "✅ запущено", failed: "❌ не вдалося", skipped: "⏭ пропущено" } as const;
const PROMPT_MAX = 600;

const zone = (s: Schedule) => ("cron" in s.when ? s.when.tz : DEFAULT_TZ);
const time = (ms: number, tz: string) => new Date(ms).toLocaleString("uk-UA", { timeZone: tz, dateStyle: "short", timeStyle: "short" });

// Картка автоматизації в чаті (ADR 0005): стан, розклад, найближчий і останній запуск, кнопки під стан. Текст простий, без розмітки.
// heading — рядок над карткою (напр. «Агент пропонує…»).
export function scheduleCard(s: Schedule, heading?: string): { text: string; reply_markup: TgInlineKeyboard } {
	const tz = zone(s);
	const last = s.runs.at(-1);
	const prompt = s.prompt.length > PROMPT_MAX ? `${s.prompt.slice(0, PROMPT_MAX)}…` : s.prompt;
	const lines = [
		heading,
		`⏰ ${s.name} · ${STATUS[s.status]}`,
		"cron" in s.when ? `Розклад: ${s.when.cron} (${s.when.tz})` : `Розклад: один раз, ${time(s.when.at, tz)}`,
		s.nextRun !== undefined && s.status !== "paused" ? `${s.status === "pending" ? "Перший запуск" : "Наступний запуск"}: ${time(s.nextRun, tz)}` : "",
		last ? `Останній запуск: ${time(last.at, tz)}, ${RESULT[last.result]}` : "",
		s.repo ? `📦 ${s.repo}` : "",
		s.model ? `🤖 ${s.model}` : "",
		s.maxCostUsd ? `💵 ліміт запуску $${s.maxCostUsd}` : "",
		s.createdBy === "agent" ? "Створив агент" : "",
	].filter(Boolean);
	const text = `${lines.join("\n")}\n\n«${prompt}»`;
	const run = { text: "▶️ Запустити зараз", callback_data: callback.schedule("run", s.id) };
	const history = { text: "📜 Історія", callback_data: callback.schedule("hist", s.id) };
	const del = { text: "🗑 Видалити", callback_data: callback.schedule("del", s.id) };
	const rows =
		s.status === "pending" ? [[{ text: "✅ Активувати", callback_data: callback.schedule("ok", s.id) }, { text: "❌ Відхилити", callback_data: callback.schedule("no", s.id) }]]
		: s.status === "active" ? [[{ text: "⏸ Пауза", callback_data: callback.schedule("pause", s.id) }, run], [history, del]]
		: s.status === "paused" ? [[{ text: "▶️ Увімкнути", callback_data: callback.schedule("resume", s.id) }, run], [history, del]]
		: [[run], [history, del]];
	return { text, reply_markup: { inline_keyboard: rows } };
}

// Історія запусків: останні 10, найновіші зверху, із посиланнями на сесії.
export function scheduleHistory(s: Schedule): string {
	if (!s.runs.length) return `📜 «${s.name}»: запусків ще не було.`;
	const rows = s.runs.slice(-10).reverse().map((r) => `${time(r.at, zone(s))} · ${RESULT[r.result]}${r.sessionId ? `\n${s.origin}/s/${r.sessionId}` : ""}${r.error ? `\n${r.error}` : ""}`);
	return `📜 «${s.name}»: останні запуски\n\n${rows.join("\n\n")}`;
}

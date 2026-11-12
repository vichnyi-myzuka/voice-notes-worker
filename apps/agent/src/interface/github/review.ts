import { tg, type BotEnv, type TgCallbackQuery } from "@voice-notes/core";
import type { Env } from "../../env";
import { reviewDeployments } from "../../infrastructure/github";

// Кнопки «Схвалити/Відхилити» під запитом на деплой. callback_data: `appr:<owner/repo>:<id запуску>` чи `rej:…`.
export const reviewButtons = (repo: string, runId: number) => ({
	inline_keyboard: [[
		{ text: "✅ Схвалити", callback_data: `appr:${repo}:${runId}` },
		{ text: "❌ Відхилити", callback_data: `rej:${repo}:${runId}` },
	]],
});

// Натискання кнопки (власник уже перевірений). Результат — спливаюча підказка, а пост втрачає кнопки й показує підсумок.
export async function handleReviewButton(bot: BotEnv, query: TgCallbackQuery, env: Env, approve: boolean, repo: string, runId: number): Promise<void> {
	const answer = (text: string) => tg(bot, "answerCallbackQuery", { callback_query_id: query.id, text }).catch((err) => console.error("answer failed:", err));
	if (!env.GITHUB_APPROVE_TOKEN) return void (await answer("Не налаштовано GITHUB_APPROVE_TOKEN."));
	const done = await reviewDeployments(env.GITHUB_APPROVE_TOKEN, repo, runId, approve).catch((err) => (console.error("review failed:", err), null));
	if (done === null) return void (await answer("Не вдалося звернутись до GitHub."));
	const message = query.message!;
	const verdict = done === 0 ? "ℹ️ Уже оброблено (або немає права)" : approve ? "✅ Схвалено" : "❌ Відхилено";
	// editMessageText без reply_markup прибирає кнопки
	await tg(bot, "editMessageText", { chat_id: message.chat.id, message_id: message.message_id, text: `${message.text ?? ""}\n\n${verdict}`, link_preview_options: { is_disabled: true } }).catch((err) => console.error("edit failed:", err));
	await answer(verdict);
}

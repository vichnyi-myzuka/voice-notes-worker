import { tg, type BotEnv, type TgCallbackQuery } from "@voice-notes/core";
import type { Env } from "../../env";
import type { Agent } from "../../domain/agent";
import { mergePull, openPullNumber, reviewDeployments } from "../../infrastructure/github";

// Кнопки «Схвалити/Відхилити» під запитом на деплой. callback_data: `appr:<owner/repo>:<id запуску>` чи `rej:…`.
export const reviewButtons = (repo: string, runId: number) => ({
	inline_keyboard: [[
		{ text: "✅ Схвалити", callback_data: `appr:${repo}:${runId}` },
		{ text: "❌ Відхилити", callback_data: `rej:${repo}:${runId}` },
	]],
});

// «🔀 Змерджити» під постом сесії (власник уже перевірений): знаходить відкритий PR гілки сесії й мерджить його. Підсумок — спливаюча
// підказка; після успіху кнопка зникає з поста (лишається «Видалити»), сесію прибере вебхук після успішного деплою.
export async function handleMergeButton(bot: BotEnv, query: TgCallbackQuery, env: Env, agent: Agent, id: string): Promise<void> {
	const answer = (text: string) => tg(bot, "answerCallbackQuery", { callback_query_id: query.id, text: text.slice(0, 200) }).catch((err) => console.error("answer failed:", err));
	const token = env.GITHUB_TOKEN;
	const target = await agent.pullTarget(id);
	if (!token || !target) return void (await answer(token ? "Сесія без репозиторію." : "Не налаштовано GITHUB_TOKEN."));
	try {
		const number = await openPullNumber(token, target.repo, target.branch);
		if (!number) return void (await answer("Відкритого PR не знайдено."));
		await mergePull(token, target.repo, number);
		const message = query.message!;
		// Пост одразу показує, що PR змерджено і йде деплой (кнопка «Змерджити» зникає); далі рядок замінить вебхук GitHub
		const shown = await agent.setDeployByPost(message.message_id, { text: `🔀 PR #${number} змерджено, чекаємо на деплой` }, true).catch(() => false);
		if (!shown) await tg(bot, "editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [[{ text: "🗑 Видалити", callback_data: `del:${id}` }]] } }).catch((err) => console.error("edit failed:", err));
		await answer(`🔀 PR #${number} змерджено`);
	} catch (err) {
		console.error("merge failed:", err);
		await answer(`Не вдалося змерджити: ${err instanceof Error ? err.message : err}`);
	}
}

// Натискання кнопки (власник уже перевірений). Результат — спливаюча підказка, а пост втрачає кнопки й показує підсумок.
export async function handleReviewButton(bot: BotEnv, query: TgCallbackQuery, env: Env, agent: Agent, approve: boolean, repo: string, runId: number): Promise<void> {
	const answer = (text: string) => tg(bot, "answerCallbackQuery", { callback_query_id: query.id, text }).catch((err) => console.error("answer failed:", err));
	if (!env.GITHUB_APPROVE_TOKEN) return void (await answer("Не налаштовано GITHUB_APPROVE_TOKEN."));
	let failure = "";
	const done = await reviewDeployments(env.GITHUB_APPROVE_TOKEN, repo, runId, approve).catch((err) => ((failure = String(err instanceof Error ? err.message : err)), console.error("review failed:", err), null));
	// У підказці лишається причина (напр. «pending deployments 403» — токену бракує прав): інакше з чату її не видно
	if (done === null) return void (await answer(`Не вдалося звернутись до GitHub: ${failure}`.slice(0, 200)));
	const message = query.message!;
	const verdict = done === 0 ? "ℹ️ Уже оброблено (або немає права)" : approve ? "✅ Схвалено" : "❌ Відхилено";
	// Пост сесії показує деплой: оновлюємо його рядок (форматування й кнопки сесії лишаються), а не весь текст
	const line = done === 0 ? "ℹ️ Деплой уже оброблено (або немає права)" : approve ? "✅ Деплой схвалено, виконується" : "❌ Деплой відхилено";
	if (await agent.setDeployByPost(message.message_id, { text: line }).catch(() => false)) return void (await answer(verdict));
	// editMessageText без reply_markup прибирає кнопки
	await tg(bot, "editMessageText", { chat_id: message.chat.id, message_id: message.message_id, text: `${message.text ?? ""}\n\n${verdict}`, link_preview_options: { is_disabled: true } }).catch((err) => console.error("edit failed:", err));
	await answer(verdict);
}

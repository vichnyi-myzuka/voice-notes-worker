import { tg, type BotEnv, type TgUpdate } from "@voice-notes/core";
import type { Agent, Deploys, Sessions } from "../../domain/agent";
import { DEFAULT_TZ, type Schedules } from "../../domain/schedule";
import type { Env } from "../../env";
import { parseCallback, removeMessage, removeOriginal, type SessionAction } from "../../infrastructure/chat";
// Єдиний дозволений імпорт між interface-модулями: ADR 0004.
// oxlint-disable-next-line no-restricted-imports
import { handleMergeButton, handleReviewButton } from "../github/review";
import { resolveRepo } from "./launch";
import { parseRepos } from "./repo";

type Query = NonNullable<TgUpdate["callback_query"]>;
type Handler = (ctx: { bot: BotEnv; query: Query; env: Env; agent: Sessions & Deploys; id: string; chatId: number; messageId: number; answer: (text: string) => Promise<unknown> }) => Promise<void>;

// Дії над сесією: кожна отримує вже перевірені чат, повідомлення й id сесії та сама відповідає спливаючою підказкою.
const sessionActions: Record<Exclude<SessionAction, "ok">, Handler> = {
	merge: ({ bot, query, env, agent, id }) => handleMergeButton(bot, query, env, agent, id, (repo) => parseRepos(env.AGENT_REPOS).find((r) => r.repo === repo)?.site),
	async del({ bot, agent, id, chatId, messageId, answer }) {
		await agent.remove(id);
		await removeMessage(bot, chatId, messageId);
		await removeOriginal(bot, chatId, id);
		await answer("Сесію видалено.");
	},
	async stop({ agent, id, answer }) {
		if ((await agent.report(id)).status !== "working") return void (await answer("Нічого зупиняти."));
		await agent.abort(id);
		await answer("⏹ Зупинено.");
	},
};

// Натискання кнопки під постом сесії (⏹ Стоп, 🗑 Видалити…). Кнопку може натиснути лише власник; відповідь іде спливаючою
// підказкою (answerCallbackQuery), у чат нічого не пишемо: стан видно в самому пості. Формат callback_data — infrastructure/chat/callback.ts.
export async function handleButton(bot: BotEnv, query: Query, env: Env, agent: Agent, schedules?: Schedules): Promise<void> {
	const answer = (text: string) => tg(bot, "answerCallbackQuery", { callback_query_id: query.id, text }).catch((err) => console.error("answer failed:", err));
	const chat = query.message?.chat;
	const allowed = !!env.TG_OWNER_ID && String(query.from.id) === env.TG_OWNER_ID && !!chat && (String(chat.id) === env.CHAT_ID || (chat.type === "private" && String(chat.id) === env.TG_OWNER_ID));
	const action = parseCallback(query.data);
	if (!allowed || !action || !query.message) return void (await answer(allowed ? "Невідома дія." : "Недоступно."));
	const chatId = chat!.id;
	const messageId = query.message.message_id;

	if (action.kind === "review") return handleReviewButton(bot, query, env, agent, action.approve, action.repo, action.runId);
	if (action.kind === "dismiss") {
		await removeMessage(bot, chatId, messageId);
		return void (await answer("Видалено."));
	}
	if (action.kind === "schedule") return handleScheduleButton(bot, schedules, action.approve, action.id, chatId, messageId, answer);
	if (action.kind === "pick") return void (await answer((await resolveRepo(bot, agent, action.id, action.choice, messageId)) ? "Запускаю." : "Вибір уже неактуальний."));
	if (!(await agent.link(action.id))) return void (await answer("Сесію не знайдено."));
	if (action.kind === "choice" || action.action === "ok") {
		const choice = action.kind === "choice" ? action.choice : "ok";
		const note = await agent.answer(action.id, choice).catch((err) => (console.error("answer failed:", err), null));
		return void (await answer(note === null ? "Не вдалося відповісти." : (note ?? "Питання вже неактуальне.")));
	}
	await sessionActions[action.action]({ bot, query, env, agent, id: action.id, chatId, messageId, answer });
}

// Підтвердження розкладу від агента: ✅ активує (перший запуск показується в тексті), ❌ видаляє. Кнопки зникають, лишається результат.
async function handleScheduleButton(bot: BotEnv, schedules: Schedules | undefined, approve: boolean, id: string, chatId: number, messageId: number, answer: (text: string) => Promise<unknown>): Promise<void> {
	if (!schedules) return void (await answer("Розклади недоступні."));
	const current = await schedules.get(id);
	if (!current || current.status !== "pending") return void (await answer("Це вже неактуально."));
	const done = (text: string) => tg(bot, "editMessageText", { chat_id: chatId, message_id: messageId, text }).catch((err) => console.error("edit failed:", err));
	if (!approve) {
		await schedules.remove(id);
		await done(`❌ Відхилено: «${current.name}»`);
		return void (await answer("Відхилено."));
	}
	const r = await schedules.resume(id);
	if (!r.ok) return void (await answer(r.error));
	const first = r.value.nextRun === undefined ? "" : `\nПерший запуск: ${new Date(r.value.nextRun).toLocaleString("uk-UA", { timeZone: "cron" in r.value.when ? r.value.when.tz : DEFAULT_TZ, dateStyle: "short", timeStyle: "short" })}`;
	await done(`✅ Активовано: «${r.value.name}»${first}`);
	await answer("Активовано.");
}

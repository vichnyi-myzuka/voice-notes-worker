import { tg, tgSendMessage, type BotEnv, type TgUpdate } from "@voice-notes/core";
import { MCP_LABELS, type Agent, type Deploys, type McpAnswer, type Sessions } from "../../domain/agent";
import type { Env } from "../../env";
import { parseCallback, removeMessage, removeOriginal, type SessionAction } from "../../infrastructure/chat";
// Єдиний дозволений імпорт між interface-модулями: ADR 0004.
// oxlint-disable-next-line no-restricted-imports
import { handleMergeButton, handleReviewButton } from "../github/review";
import { resolveMcp, resolveRepo } from "./launch";
import { parseRepos } from "./repo";

type Query = NonNullable<TgUpdate["callback_query"]>;
type Handler = (ctx: { bot: BotEnv; query: Query; env: Env; agent: Sessions & Deploys; id: string; chatId: number; messageId: number; answer: (text: string) => Promise<unknown> }) => Promise<void>;

// Що кажемо агентові, коли власник натиснув «Повторити» після лімітів.
const RETRY_TEXT = "Ліміти скинулись. Продовж виконувати попереднє завдання з того місця, де зупинився.";

const MCP_ANSWERS: Record<McpAnswer, string> = { connected: "Підключено, агент продовжує.", declined: "Відхилено.", login: "Потрібен вхід у сервіс.", unavailable: "Сервіс не налаштований." };

// Дії над сесією: кожна отримує вже перевірені чат, повідомлення й id сесії та сама відповідає спливаючою підказкою.
const sessionActions: Record<Exclude<SessionAction, "ok">, Handler> = {
	merge: ({ bot, query, env, agent, id }) => handleMergeButton(bot, query, env, agent, id, (repo) => parseRepos(env.AGENT_REPOS).find((r) => r.repo === repo)?.site),
	async del({ bot, agent, id, chatId, messageId, answer }) {
		await agent.remove(id);
		await removeMessage(bot, chatId, messageId);
		await removeOriginal(bot, chatId, id);
		await answer("Сесію видалено.");
	},
	async retry({ query, agent, id, chatId, answer }) {
		if ((await agent.report(id)).status === "working") return void (await answer("Агент уже працює."));
		await agent.resume(id, RETRY_TEXT, { chatId, url: agent.url(id), ...(query.message?.message_thread_id && { threadId: query.message.message_thread_id }) });
		await answer("🔄 Повторюю.");
	},
	async stop({ agent, id, answer }) {
		if ((await agent.report(id)).status !== "working") return void (await answer("Нічого зупиняти."));
		await agent.abort(id);
		await answer("⏹ Зупинено.");
	},
};

// Натискання кнопки під постом сесії (⏹ Стоп, 🗑 Видалити…). Кнопку може натиснути лише власник; відповідь іде спливаючою
// підказкою (answerCallbackQuery), у чат нічого не пишемо: стан видно в самому пості. Формат callback_data — infrastructure/chat/callback.ts.
export async function handleButton(bot: BotEnv, query: Query, env: Env, agent: Agent): Promise<void> {
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
	if (action.kind === "pick") return void (await answer((await resolveRepo(bot, agent, action.id, action.choice, messageId)) ? "Запускаю." : "Вибір уже неактуальний."));
	if (action.kind === "mcp-start") return void (await answer((await resolveMcp(bot, agent, action.id, action.allow, messageId)) ? (action.allow ? "Підключаю й запускаю." : "Запускаю без них.") : "Вибір уже неактуальний."));
	if (!(await agent.link(action.id))) return void (await answer("Сесію не знайдено."));
	if (action.kind === "mcp-live") {
		const result = await agent.answerMcp(action.id, action.name, action.allow).catch((err) => (console.error("mcp answer failed:", err), null));
		if (result === null) return void (await answer("Не вдалося підключити."));
		await removeMessage(bot, chatId, messageId);
		// Без входу в сервіс агент отримав примітку, а власнику одразу даємо посилання на вхід (у тій самій темі).
		if (result === "login") await tgSendMessage(bot, chatId, `${MCP_LABELS[action.name]} ще не підключено. Увійди тут і повтори запит агенту: ${new URL(agent.url(action.id)).origin}/${action.name}/login`, query.message.message_thread_id);
		return void (await answer(MCP_ANSWERS[result]));
	}
	if (action.kind === "choice" || action.action === "ok") {
		const choice = action.kind === "choice" ? action.choice : "ok";
		const note = await agent.answer(action.id, choice).catch((err) => (console.error("answer failed:", err), null));
		return void (await answer(note === null ? "Не вдалося відповісти." : (note ?? "Питання вже неактуальне.")));
	}
	await sessionActions[action.action]({ bot, query, env, agent, id: action.id, chatId, messageId, answer });
}

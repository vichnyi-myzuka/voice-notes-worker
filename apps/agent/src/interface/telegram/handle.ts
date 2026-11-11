import { DOWNLOAD_MAX_BYTES, react, safeEqual, tg, tgSendMessage, type BotEnv, type Llm, type TgMessage, type TgUpdate } from "@voice-notes/core";
import type { Agent, SessionReport } from "../../domain/agent";
import type { Env } from "../../env";
import { sendChat } from "../../infrastructure/chat";
import { routeTask, type KnownRepo } from "./repo";

export const TELEGRAM_PATH = "/telegram";

// Що потрібно обробнику: агент, розпізнавання голосу і спосіб довести роботу до кінця після відповіді Telegram.
// repos: відомі репозиторії, з яких бот вибирає за вільною фразою (див. repo.ts); без них репозиторій задає лише префікс.
export type TelegramDeps = { agent: Agent; llm: Llm; defer: (work: Promise<unknown>) => void; repos?: KnownRepo[] };

const POST_MAX = 3500; // запас до ліміту повідомлення Telegram (4096): решта — посилання

// Вебхук чату з агентом: канал CHAT_ID (бот адмін) і особистий чат власника, як у боті нотаток. Це єдиний шлях повз
// Cloudflare Access (Telegram не пройде логін), тому захист тут свій: секретний заголовок, а далі лише канал CHAT_ID
// (дописувати в нього можуть лише адміни) і особистий чат TG_OWNER_ID. Telegram завжди отримує 200 одразу, а робота
// (Whisper, холодний старт контейнера) йде у фоні: інакше він би повторював запит.
export async function handleTelegram(req: Request, env: Env, deps: TelegramDeps): Promise<Response> {
	const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (req.method !== "POST" || !env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
		return new Response("unauthorized", { status: 401 });
	}
	if (!env.BOT_TOKEN) return new Response("bot is not configured", { status: 503 });
	const bot = { BOT_TOKEN: env.BOT_TOKEN };
	const update = await req.json<TgUpdate>().catch(() => null);
	if (update?.callback_query) {
		deps.defer(handleButton(bot, update.callback_query, env, deps.agent).catch((err) => console.error("telegram button failed:", err)));
		return new Response("ok");
	}
	const msg = update?.message ?? update?.channel_post;
	if (!msg) return new Response("ok");

	const inChannel = msg.chat.type === "channel" && !!env.CHAT_ID && String(msg.chat.id) === env.CHAT_ID;
	const inPrivate = msg.chat.type === "private" && !!env.TG_OWNER_ID && String(msg.from?.id) === env.TG_OWNER_ID;
	if (inChannel || inPrivate) {
		deps.defer(
			handleMessage(bot, msg, inChannel, deps).catch(async (err) => {
				console.error("telegram message failed:", err);
				await tgSendMessage(bot, msg.chat.id, "⚠️ Не вдалося створити сесію, спробуй ще раз.").catch(() => {});
			}),
		);
	}
	return new Response("ok");
}

// Натискання кнопки під постом сесії (⏹ Стоп, 🗑 Видалити). Кнопку може натиснути лише власник; відповідь іде спливаючою
// підказкою (answerCallbackQuery), у чат нічого не пишемо: стан видно в самому пості.
async function handleButton(bot: BotEnv, query: NonNullable<TgUpdate["callback_query"]>, env: Env, agent: Agent): Promise<void> {
	const answer = (text: string) => tg(bot, "answerCallbackQuery", { callback_query_id: query.id, text }).catch((err) => console.error("answer failed:", err));
	const chat = query.message?.chat;
	const allowed = !!env.TG_OWNER_ID && String(query.from.id) === env.TG_OWNER_ID && !!chat && (String(chat.id) === env.CHAT_ID || (chat.type === "private" && String(chat.id) === env.TG_OWNER_ID));
	const [, action, id, choice] = /^(stop|del|ans|tog|ok):(tg-[\w-]+)(?::(\d+))?$/.exec(query.data ?? "") ?? [];
	if (!allowed || !action || !query.message) return void (await answer(allowed ? "Невідома дія." : "Недоступно."));
	if (!(await agent.link(id))) return void (await answer("Сесію не знайдено."));
	if (action === "ans" || action === "tog" || action === "ok") {
		const note = await agent.answer(id, action === "ok" ? "ok" : Number(choice)).catch((err) => (console.error("answer failed:", err), null));
		return void (await answer(note === null ? "Не вдалося відповісти." : (note ?? "Питання вже неактуальне.")));
	}
	if (action === "del") {
		await agent.remove(id);
		await removeMessage(bot, chat.id, query.message.message_id);
		return void (await answer("Сесію видалено."));
	}
	if ((await agent.report(id)).status !== "working") return void (await answer("Нічого зупиняти."));
	await agent.abort(id);
	await answer("⏹ Зупинено.");
}

// Посилання на сесію в пості бота: з нього відповідь (reply) знаходить, до якої сесії належить.
const SESSION_URL = /https?:\/\/\S+\/s\/(tg-[\w-]+)/;
// Примусове оновлення: контейнер зупиняється, знімок видаляється; наступне завдання стартує з поточного образу (деплой
// і так робить це сам при першому зверненні, команда потрібна, коли оновити треба одразу). Працюючих агентів не чіпає без force.
async function updateContainer(env: BotEnv, chat: number, agent: Agent, force: boolean): Promise<void> {
	if (!(await agent.resetComputer(!force))) {
		return void (await tgSendMessage(env, chat, "⏳ Зараз працює агент. Дочекайся завершення або надішли /update force, щоб перервати."));
	}
	await tgSendMessage(env, chat, "🔄 Контейнер зупинено: наступне завдання стартує з поточного образу. Старі сесії скинуто (гілки в GitHub лишились).");
}

const removeMessage = (env: BotEnv, chat: number, messageId: number) =>
	tg(env, "deleteMessage", { chat_id: chat, message_id: messageId }).catch((err) => console.error("delete message failed:", err));

// Текст повідомлення разом з адресами клікабельних слів: посилання на сесію в пості тепер сховане під «Відкрити сесію».
function textWithLinks(m: TgMessage["reply_to_message"]): string {
	const entities = [...(m?.entities ?? []), ...(m?.caption_entities ?? [])];
	return [m?.text ?? m?.caption ?? "", ...entities.flatMap((e) => (e.url ? [e.url] : []))].join("\n");
}

// «owner/name: задача» на початку тексту — репозиторій для сесії.
const REPO_PREFIX = /^([\w-][\w.-]*\/[\w-][\w.-]*)\s*:\s*([\s\S]+)$/;

async function handleMessage(env: BotEnv, msg: TgMessage, inChannel: boolean, { agent, llm, repos = [] }: TelegramDeps): Promise<void> {
	const chat = msg.chat.id;
	const file = msg.voice ?? msg.audio;
	const text = msg.text?.trim();
	const replied = SESSION_URL.exec(textWithLinks(msg.reply_to_message));
	const say = (t: string) => tgSendMessage(env, chat, t);

	if (!file && (!text || text.startsWith("/"))) {
		const command = text?.split(/[\s@]/)[0];
		if (command === "/start") await say("Надішли голосове чи текст із задачею: у відповідь прийде посилання на сесію агента. Відповідь на пост із сесією — уточнення, /status показує стан, /stop зупиняє, /delete видаляє сесію, /update перезапускає контейнер з поточного образу.");
		else if (command === "/update") await updateContainer(env, chat, agent, /\bforce\b/i.test(text ?? ""));
		else if (command === "/status" || command === "/stop" || command === "/delete") {
			if (!replied) await say(`Надішли ${command} відповіддю на пост із сесією.`);
			else await sessionCommand(env, chat, agent, replied[1], command, msg.reply_to_message?.message_id);
		}
		// Команда виконана: саму команду з чату прибираємо (відповідь бота лишається), як і прийняті уточнення.
		if (command === "/status" || command === "/stop" || command === "/delete" || command === "/update") await removeMessage(env, chat, msg.message_id);
		return;
	}
	if (file && (file.file_size ?? 0) > DOWNLOAD_MAX_BYTES) {
		await say("⚠️ Файл більший за 20 МБ: бот не може його завантажити.");
		return;
	}
	await react(env, msg);

	// Відповідь на пост із сесією — уточнення в ту саму сесію.
	if (replied) {
		const [url, id] = replied;
		if (!(await agent.link(id))) return void (await say("⚠️ Сесію не знайдено (можливо, вона з іншого агента)."));
		const followUp = await transcribe(env, llm, file, text);
		if (!followUp) return void (await say("⚠️ Не розібрав голос, надішли ще раз чи напиши текстом."));
		await agent.resume(id, followUp, { chatId: chat, url });
		// Уточнення прийнято: саме повідомлення прибираємо (як правку нотатки), стан видно в пості сесії (він оновлюється на місці) і за 👨‍💻.
		await removeMessage(env, chat, msg.message_id);
		return;
	}

	// Стабільний id: повторна доставка того самого повідомлення не створює другу сесію й другу відповідь.
	const id = `tg-${chat}-${msg.message_id}`;
	if (await agent.link(id)) return;

	const transcript = await transcribe(env, llm, file, text);
	if (!transcript) return void (await say("⚠️ Не розібрав голос, надішли ще раз чи напиши текстом."));
	// Явний префікс сильніший за здогад репозиторію; назву для теки/гілки модель придумує завжди. У пості видно, що вибрано.
	const withRepo = REPO_PREFIX.exec(transcript);
	const prompt = withRepo ? withRepo[2].trim() : transcript;
	const route = await routeTask(llm, withRepo ? [] : repos, prompt);
	const repo = withRepo ? withRepo[1] : route.repo;

	const url = agent.url(id);
	// У каналі оригінал замінюється постом із задачею (як у нотатках), у приваті оригінал лишається, тож задачу не дублюємо.
	const shown = inChannel || file ? `${file ? "🗣 " : ""}${prompt.length > POST_MAX ? `${prompt.slice(0, POST_MAX)}…` : prompt}\n\n` : "";
	// Без прев'ю: інакше Telegram показує картку сторінки за Access.
	// Один пост на сесію: агент оновлює його на місці (⏳ Працює → підсумок), нових повідомлень про стан немає.
	const header = `${shown}${repo ? `📦 ${repo}` : ""}`.trim();
	const postId = await sendChat(env, chat, [header, "⏳ Запускаю"].filter(Boolean).join("\n\n"), url, "working");
	// Запуск (холодний старт контейнера, клон) іде в Durable Object і не залежить від життя цього запиту; збій він покаже в пості.
	await agent.begin(id, { prompt, ...(repo && { repo }), ...(route.name && { name: route.name }) }, { chatId: chat, url, postId, header });
	if (inChannel) await tg(env, "deleteMessage", { chat_id: chat, message_id: msg.message_id }).catch((err) => console.error("delete original failed:", err));
}

// Голосове → текст через Whisper; текст як є. Порожній рядок — не розібрали.
async function transcribe(env: BotEnv, llm: Llm, file: { file_id: string; mime_type?: string } | undefined, text: string | undefined): Promise<string> {
	if (!file) return text ?? "";
	const info = await tg(env, "getFile", { file_id: file.file_id });
	const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
	if (!res.ok) throw new Error(`download ${res.status}`);
	return llm.transcribe(await res.arrayBuffer(), file.mime_type ?? "audio/ogg");
}

async function sessionCommand(env: BotEnv, chat: number, agent: Agent, id: string, command: "/status" | "/stop" | "/delete", postId?: number): Promise<void> {
	if (!(await agent.link(id))) return void (await tgSendMessage(env, chat, "⚠️ Сесію не знайдено."));
	if (command === "/delete") {
		await agent.remove(id);
		if (postId) await tg(env, "deleteMessage", { chat_id: chat, message_id: postId }).catch((err) => console.error("delete post failed:", err));
		return; // підтвердження не шлемо: пост і сама команда зникають з чату
	}
	const report = await agent.report(id);
	if (command === "/stop") {
		if (report.status !== "working") return void (await tgSendMessage(env, chat, `Нічого зупиняти: ${describe(report)}`));
		await agent.abort(id);
		return void (await tgSendMessage(env, chat, "⏹ Зупинено. Відповідь на пост із сесією продовжить роботу."));
	}
	await tgSendMessage(env, chat, describe(report));
}

// Стан сесії для людини: працює / чекає / завершила / помилка / зупинена / контейнер спить.
export function describe({ status, outcome, cost, tokens }: SessionReport): string {
	const state =
		status === "stopped" ? "💤 Контейнер спить, історія збережена. Уточнення розбудить його."
		: status === "working" ? "⏳ Працює"
		: outcome === "succeeded" ? "✅ Завершила"
		: outcome === "failed" ? "❌ Завершилась помилкою"
		: outcome === "interrupted" ? "⏹ Зупинена"
		: "💤 Чекає на відповідь";
	const spent = [cost ? `$${cost.toFixed(2)}` : "", tokens ? `${Math.round(tokens / 1000)}k токенів` : ""].filter(Boolean).join(" · ");
	return spent ? `${state} (${spent})` : state;
}

import { DOWNLOAD_MAX_BYTES, react, safeEqual, tg, tgSendMessage, type BotEnv, type Llm, type TgMessage, type TgUpdate } from "@voice-notes/core";
import type { Agent, SessionReport } from "../../domain/agent";
import type { Env } from "../../env";

export const TELEGRAM_PATH = "/telegram";

// Що потрібно обробнику: агент, розпізнавання голосу і спосіб довести роботу до кінця після відповіді Telegram.
export type TelegramDeps = { agent: Agent; llm: Llm; defer: (work: Promise<unknown>) => void };

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

// Посилання на сесію в пості бота: з нього відповідь (reply) знаходить, до якої сесії належить.
const SESSION_URL = /https?:\/\/\S+\/s\/(tg-[\w-]+)/;
// «owner/name: задача» на початку тексту — репозиторій для сесії.
const REPO_PREFIX = /^([\w-][\w.-]*\/[\w-][\w.-]*)\s*:\s*([\s\S]+)$/;

async function handleMessage(env: BotEnv, msg: TgMessage, inChannel: boolean, { agent, llm }: TelegramDeps): Promise<void> {
	const chat = msg.chat.id;
	const file = msg.voice ?? msg.audio;
	const text = msg.text?.trim();
	const replied = SESSION_URL.exec(msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "");
	const say = (t: string) => tgSendMessage(env, chat, t);

	if (!file && (!text || text.startsWith("/"))) {
		const command = text?.split(/[\s@]/)[0];
		if (command === "/start") await say("Надішли голосове чи текст із задачею: у відповідь прийде посилання на сесію агента. Відповідь на пост із сесією — уточнення, /status показує стан, /stop зупиняє.");
		else if (command === "/status" || command === "/stop") {
			if (!replied) await say(`Надішли ${command} відповіддю на пост із сесією.`);
			else await sessionCommand(env, chat, agent, replied[1], command);
		}
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
		await agent.followUp(id, followUp);
		await agent.watch(id, { chatId: chat, url }).catch((err) => console.error("watch failed:", err));
		return;
	}

	// Стабільний id: повторна доставка того самого повідомлення не створює другу сесію й другу відповідь.
	const id = `tg-${chat}-${msg.message_id}`;
	if (await agent.link(id)) return;

	const transcript = await transcribe(env, llm, file, text);
	if (!transcript) return void (await say("⚠️ Не розібрав голос, надішли ще раз чи напиши текстом."));
	const withRepo = REPO_PREFIX.exec(transcript);
	const [repo, prompt] = withRepo ? [withRepo[1], withRepo[2].trim()] : [undefined, transcript];

	const { url } = await agent.start(id, { prompt, ...(repo && { repo }) });
	await agent.watch(id, { chatId: chat, url }).catch((err) => console.error("watch failed:", err));
	// У каналі оригінал замінюється постом із задачею (як у нотатках), у приваті оригінал лишається, тож задачу не дублюємо.
	const shown = inChannel || file ? `${file ? "🗣 " : ""}${prompt.length > POST_MAX ? `${prompt.slice(0, POST_MAX)}…` : prompt}\n\n` : "";
	// Без прев'ю: інакше Telegram показує картку сторінки за Access.
	await tg(env, "sendMessage", { chat_id: chat, text: `${shown}${repo ? `📦 ${repo}\n` : ""}🔗 ${url}`, link_preview_options: { is_disabled: true } });
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

async function sessionCommand(env: BotEnv, chat: number, agent: Agent, id: string, command: "/status" | "/stop"): Promise<void> {
	if (!(await agent.link(id))) return void (await tgSendMessage(env, chat, "⚠️ Сесію не знайдено."));
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

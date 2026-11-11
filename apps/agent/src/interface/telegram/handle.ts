import { DOWNLOAD_MAX_BYTES, react, safeEqual, tg, tgSendMessage, type BotEnv, type Llm, type TgMessage, type TgUpdate } from "@voice-notes/core";
import type { Agent } from "../../domain/agent";
import type { Env } from "../../env";

export const TELEGRAM_PATH = "/telegram";

// Що потрібно обробнику: агент, розпізнавання голосу і спосіб довести роботу до кінця після відповіді Telegram.
export type TelegramDeps = { agent: Agent; llm: Llm; defer: (work: Promise<unknown>) => void };

// Вебхук чату з агентом. Це єдиний шлях повз Cloudflare Access (Telegram не пройде логін), тому захист тут свій:
// секретний заголовок і лише власник (TG_OWNER_ID). Telegram завжди отримує 200 одразу, а робота (Whisper, холодний старт
// контейнера) йде у фоні: інакше він би повторював запит. Повторна доставка не створює другу сесію: id сесії стабільний.
export async function handleTelegram(req: Request, env: Env, deps: TelegramDeps): Promise<Response> {
	const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (req.method !== "POST" || !env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
		return new Response("unauthorized", { status: 401 });
	}
	if (!env.BOT_TOKEN) return new Response("bot is not configured", { status: 503 });
	const bot = { BOT_TOKEN: env.BOT_TOKEN };
	const update = await req.json<TgUpdate>().catch(() => null);
	const msg = update?.message;
	if (msg && msg.chat.type === "private" && !!env.TG_OWNER_ID && String(msg.from?.id) === env.TG_OWNER_ID) {
		deps.defer(
			handleMessage(bot, msg, deps).catch(async (err) => {
				console.error("telegram message failed:", err);
				await tgSendMessage(bot, msg.chat.id, "⚠️ Не вдалося створити сесію, спробуй ще раз.").catch(() => {});
			}),
		);
	}
	return new Response("ok");
}

async function handleMessage(env: BotEnv, msg: TgMessage, { agent, llm }: TelegramDeps): Promise<void> {
	const chat = msg.chat.id;
	const file = msg.voice ?? msg.audio;
	const text = msg.text?.trim();

	if (!file && (!text || text.startsWith("/"))) {
		if (text?.startsWith("/start")) await tgSendMessage(env, chat, "Надішли голосове чи текст із задачею: у відповідь прийде посилання на сесію агента.");
		return;
	}
	if (file && (file.file_size ?? 0) > DOWNLOAD_MAX_BYTES) {
		await tgSendMessage(env, chat, "⚠️ Файл більший за 20 МБ: бот не може його завантажити.");
		return;
	}
	await react(env, msg);

	let prompt = text ?? "";
	if (file) {
		const info = await tg(env, "getFile", { file_id: file.file_id });
		const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
		if (!res.ok) throw new Error(`download ${res.status}`);
		prompt = await llm.transcribe(await res.arrayBuffer(), file.mime_type ?? "audio/ogg");
		if (!prompt) {
			await tgSendMessage(env, chat, "⚠️ Не розібрав голос, надішли ще раз чи напиши текстом.");
			return;
		}
	}

	// Стабільний id: повторна доставка того самого повідомлення дає ту саму сесію (start ідемпотентний).
	const { url } = await agent.start(`tg-${chat}-${msg.message_id}`, { prompt });
	await tgSendMessage(env, chat, `${file ? `🗣 ${prompt}\n\n` : ""}🔗 ${url}`);
}

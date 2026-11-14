import { DOWNLOAD_MAX_BYTES, downloadTelegramFile, react, safeEqual, tg, tgSendMessage, type BotEnv, type Llm, type TgMessage, type TgUpdate } from "@voice-notes/core";
import type { Agent, ImageRef } from "../../domain/agent";
import type { Env } from "../../env";
import { removeMessage, sayTemporarily } from "../../infrastructure/chat";
import { handleButton } from "./buttons";
import { quotaText, sessionCommand, updateContainer, type Say } from "./commands";
import { askRepo, launchSession, type Pending } from "./launch";
import { routeTask, type KnownRepo } from "./repo";

export const TELEGRAM_PATH = "/telegram";

// Що потрібно обробнику: агент, розпізнавання голосу і спосіб довести роботу до кінця після відповіді Telegram.
// repos: відомі репозиторії, з яких бот вибирає за вільною фразою (див. repo.ts); без них репозиторій задає лише префікс.
// syncCommands: виставляти меню `/`-команд (див. syncCommands); у тестах вимкнено.
export type TelegramDeps = { agent: Agent; llm: Llm; defer: (work: Promise<unknown>) => void; repos?: KnownRepo[]; sleep?: (ms: number) => Promise<void>; syncCommands?: boolean };

// Меню `/`-команд у приваті. Єдине місце, де вони перелічені: додаєш команду в обробник — додай і сюди.
export const COMMANDS = [
	{ command: "status", description: "Стан сесії (відповіддю на її пост)" },
	{ command: "stop", description: "Зупинити сесію (відповіддю на пост)" },
	{ command: "model", description: "Змінити модель сесії: /model opus (відповіддю на пост)" },
	{ command: "delete", description: "Видалити сесію (відповіддю на пост)" },
	{ command: "quota", description: "Ліміти підписки Claude" },
	{ command: "update", description: "Перезапустити контейнер з поточного образу" },
];

// Воркер не має хука «після деплою», тож меню виставляє перший вебхук нового екземпляра воркера (а екземпляр після деплою
// новий): setMyCommands ідемпотентний і дешевий. Той самий список не надсилається вдруге, збій дозволяє повторити.
let syncedCommands = "";
export async function syncCommands(bot: BotEnv): Promise<void> {
	const body = JSON.stringify(COMMANDS);
	if (syncedCommands === body) return;
	syncedCommands = body;
	await tg(bot, "setMyCommands", { commands: COMMANDS, scope: { type: "all_private_chats" } }).catch((err) => {
		syncedCommands = "";
		console.error("setMyCommands failed:", err);
	});
}

// Задача для фото без підпису.
const IMAGE_ONLY = "Користувач надіслав зображення (див. вкладення).";

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
	if (deps.syncCommands) deps.defer(syncCommands(bot));
	const update = await req.json<TgUpdate>().catch(() => null);
	if (update?.callback_query) {
		deps.defer(handleButton(bot, update.callback_query, env, deps.agent).catch((err) => console.error("telegram button failed:", err)));
		return new Response("ok");
	}
	const msg = update?.message ?? update?.channel_post;
	if (!msg) {
		console.log(`telegram update ignored: no message (keys: ${Object.keys(update ?? {}).join(",") || "unparsed"})`);
		return new Response("ok");
	}

	const inChannel = msg.chat.type === "channel" && !!env.CHAT_ID && String(msg.chat.id) === env.CHAT_ID;
	const inPrivate = msg.chat.type === "private" && !!env.TG_OWNER_ID && String(msg.from?.id) === env.TG_OWNER_ID;
	// Без тексту повідомлення: лише те, що потрібно, щоб зрозуміти, куди воно пішло.
	console.log(
		`telegram message ${msg.chat.id}/${msg.message_id}: chat=${msg.chat.type} from=${msg.from?.id ?? "-"} kind=${msg.voice ? "voice" : msg.audio ? "audio" : msg.photo ? "photo" : msg.document ? "document" : msg.text ? "text" : "other"} reply=${msg.reply_to_message?.message_id ?? "-"} route=${inChannel ? "channel" : inPrivate ? "private" : "DROPPED"}${!inChannel && !inPrivate ? ` (CHAT_ID set: ${!!env.CHAT_ID}, TG_OWNER_ID set: ${!!env.TG_OWNER_ID})` : ""}`,
	);
	if (inChannel || inPrivate) {
		deps.defer(
			handleMessage(bot, msg, inChannel, deps, env.CLAUDE_CODE_OAUTH_TOKEN).catch(async (err) => {
				console.error("telegram message failed:", err);
				await tgSendMessage(bot, msg.chat.id, "⚠️ Не вдалося створити сесію, спробуй ще раз.", msg.message_thread_id).catch(() => {});
			}),
		);
	}
	return new Response("ok");
}

// Посилання на сесію в пості бота: з нього відповідь (reply) знаходить, до якої сесії належить.
const SESSION_URL = /https?:\/\/\S+\/s\/(tg-[\w-]+)/;
// Текст повідомлення разом з адресами клікабельних слів: посилання на сесію в пості тепер сховане під «Відкрити сесію».
function textWithLinks(m: TgMessage["reply_to_message"]): string {
	const entities = [...(m?.entities ?? []), ...(m?.caption_entities ?? [])];
	return [m?.text ?? m?.caption ?? "", ...entities.flatMap((e) => (e.url ? [e.url] : []))].join("\n");
}

// «owner/name: задача» на початку тексту — репозиторій для сесії.
const REPO_PREFIX = /^([\w-][\w.-]*\/[\w-][\w.-]*)\s*:\s*([\s\S]+)$/;
// «@opus» (чи «@провайдер/модель») перед усім іншим — модель для нової сесії.
const MODEL_PREFIX = /^@([\w.-]+(?:\/[\w.:-]+)?)\s+([\s\S]+)$/;
// Голосом «@» не продиктуєш: «модель опус, задача» (чи «model opus …») на початку розшифровки. Лише відомі назви, щоб
// звичайна задача на кшталт «модель користувача…» не вважалась вибором моделі.
const SPOKEN_MODELS: Record<string, string> = { opus: "opus", опус: "opus", sonnet: "sonnet", сонет: "sonnet", соннет: "sonnet", haiku: "haiku", хайку: "haiku" };
const SPOKEN_MODEL_PREFIX = /^(?:модель|model)\s+([\p{L}]+)[\s,.:;!—–-]+([\s\S]+)$/iu;

function modelPrefix(transcript: string): { model: string; task: string } | undefined {
	const at = MODEL_PREFIX.exec(transcript);
	if (at) return { model: at[1], task: at[2] };
	const spoken = SPOKEN_MODEL_PREFIX.exec(transcript);
	const model = spoken && SPOKEN_MODELS[spoken[1].toLowerCase()];
	return spoken && model ? { model, task: spoken[2] } : undefined;
}

// Явне ввімкнення MCP Sure (фінанси власника): «@sure задача» чи голосом «шур, задача» на початку. Без префікса Sure вмикає висновок
// моделі (routeTask: задача потребує особистих фінансів власника), тож слово «шур» не обов'язкове.
const SURE_PREFIX = /^(?:@sure|shure|шур|шюр|шуре)[\s,.:;!—–-]+([\s\S]+)$/iu;

// Те саме для MCP Сільпо (покупки в магазині): «@silpo задача» чи голосом «сільпо, задача».
const SILPO_PREFIX = /^(?:@silpo|silpo|сільпо|сильпо|сілпо)[\s,.:;!—–-]+([\s\S]+)$/iu;

// Те саме для MCP Google Calendar: «@calendar задача» чи голосом «календар, задача».
const CALENDAR_PREFIX = /^(?:@calendar|calendar|календар|календарю|календаря)[\s,.:;!—–-]+([\s\S]+)$/iu;

// Те саме для MCP Cloudflare, але лише явно (роутер моделі його не вмикає: інструмент керує акаунтом): «@cloudflare задача» чи голосом «клаудфлер, задача».
const CLOUDFLARE_PREFIX = /^(?:@cloudflare|cloudflare|клаудфлер|клауд флер|клаудфлеру|клаудфлера|клаудфлейр|клодфлер)[\s,.:;!—–-]+([\s\S]+)$/iu;

// Шукає префікси моделі, Sure, Сільпо, Календаря і Cloudflare в будь-якому порядку; повертає задачу без них.
function parsePrefixes(transcript: string): { task: string; model?: string; sure: boolean; silpo: boolean; calendar: boolean; cloudflare: boolean } {
	let task = transcript;
	let model: string | undefined;
	let sure = false;
	let silpo = false;
	let calendar = false;
	let cloudflare = false;
	for (let i = 0; i < 5; i++) {
		const m = !model && modelPrefix(task);
		if (m) ({ model, task } = m);
		const sm = !sure && SURE_PREFIX.exec(task);
		if (sm) {
			task = sm[1];
			sure = true;
		}
		const lm = !silpo && SILPO_PREFIX.exec(task);
		if (lm) {
			task = lm[1];
			silpo = true;
		}
		const cm = !calendar && CALENDAR_PREFIX.exec(task);
		if (cm) {
			task = cm[1];
			calendar = true;
		}
		const fm = !cloudflare && CLOUDFLARE_PREFIX.exec(task);
		if (fm) {
			task = fm[1];
			cloudflare = true;
		}
	}
	return { task: task.trim(), model, sure, silpo, calendar, cloudflare };
}

async function handleMessage(env: BotEnv, msg: TgMessage, inChannel: boolean, { agent, llm, repos = [], sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }: TelegramDeps, claudeToken?: string): Promise<void> {
	const chat = msg.chat.id;
	const file = msg.voice ?? msg.audio;
	// Фото (стиснене чи надіслане файлом) іде агентові як зображення; підпис до нього — текст задачі.
	const photo = msg.photo?.at(-1);
	const image: (ImageRef & { size?: number }) | undefined = photo ? { fileId: photo.file_id, mime: "image/jpeg", size: photo.file_size } : msg.document?.mime_type?.startsWith("image/") ? { fileId: msg.document.file_id, mime: msg.document.mime_type, size: msg.document.file_size } : undefined;
	const images = image ? [{ fileId: image.fileId, mime: image.mime }] : undefined;
	const text = (msg.text ?? (image ? msg.caption : undefined))?.trim();
	// Тема приватного чату: повідомлення в ній без reply теж належить сесії цієї теми (тема створюється під кожну нову сесію).
	const threadId = inChannel ? undefined : msg.message_thread_id;
	const viaReply = SESSION_URL.exec(textWithLinks(msg.reply_to_message));
	const threadSession = !viaReply && threadId ? await agent.byThread(chat, threadId) : undefined;
	const replied: [string, string] | undefined = viaReply ? [viaReply[0], viaReply[1]] : threadSession ? [agent.url(threadSession), threadSession] : undefined;
	const say = (t: string) => tgSendMessage(env, chat, t, threadId);
	const cleanups: Promise<unknown>[] = [];
	const sayTemp: Say = (t) => sayTemporarily(env, chat, t, sleep, cleanups, threadId);

	if (!file && !image && (!text || text.startsWith("/"))) {
		const command = text?.split(/[\s@]/)[0];
		console.log(`telegram ${chat}/${msg.message_id}: command=${command ?? "(empty)"} reply-to-session=${replied?.[1] ?? "-"}`);
		if (command === "/start") await say("Надішли голосове чи текст із задачею: у відповідь прийде посилання на сесію агента. Відповідь на пост із сесією — уточнення, /status показує стан, /stop зупиняє, /model opus змінює модель сесії (початок тексту «@opus задача» задає модель одразу), /delete видаляє сесію, /quota показує ліміти Claude, /update перезапускає контейнер з поточного образу.");
		else if (command === "/update") await updateContainer(sayTemp, agent, /\bforce\b/i.test(text ?? ""));
		else if (command === "/quota") await sayTemp(await quotaText(claudeToken));
		else if (command === "/model") {
			const model = text?.split(/\s+/)[1];
			if (!replied || !model) await sayTemp("Надішли /model <модель> (наприклад, /model opus) відповіддю на пост із сесією.");
			else if (!(await agent.link(replied[1]))) await sayTemp("⚠️ Сесію не знайдено.");
			else await sayTemp((await agent.setModel(replied[1], model)) ? `🤖 Модель сесії: ${model} (з наступного ходу).` : `⚠️ Модель ${model} недоступна.`);
		}
		else if (command === "/status" || command === "/stop" || command === "/delete") {
			if (!replied) await sayTemp(`Надішли ${command} відповіддю на пост із сесією.`);
			else await sessionCommand(env, chat, agent, sayTemp, replied[1], command, msg.reply_to_message?.message_id);
		}
		// Команда виконана: саму команду з чату прибираємо (відповідь бота лишається), як і прийняті уточнення.
		if (command === "/status" || command === "/stop" || command === "/delete" || command === "/update" || command === "/quota" || command === "/model") await removeMessage(env, chat, msg.message_id);
		await Promise.all(cleanups); // відповідь зникне через EPHEMERAL_MS
		return;
	}
	if (((file?.file_size ?? image?.size) ?? 0) > DOWNLOAD_MAX_BYTES) {
		await say("⚠️ Файл більший за 20 МБ: бот не може його завантажити.");
		return;
	}
	await react(env, msg);

	// Відповідь на пост із сесією — уточнення в ту саму сесію.
	if (replied) {
		const [url, id] = replied;
		console.log(`telegram ${chat}/${msg.message_id}: follow-up to session ${id}`);
		if (!(await agent.link(id))) return void (await say("⚠️ Сесію не знайдено (можливо, вона з іншого агента)."));
		const followUp = (await transcribe(env, llm, file, text)) || (image ? IMAGE_ONLY : "");
		if (!followUp) return void (await say("⚠️ Не розібрав голос, надішли ще раз чи напиши текстом."));
		await agent.resume(id, followUp, { chatId: chat, url, ...(threadId && { threadId }) }, images);
		// Уточнення прийнято: саме повідомлення прибираємо (як правку нотатки), стан видно в пості сесії (він оновлюється на місці) і за 👨‍💻.
		await removeMessage(env, chat, msg.message_id);
		return;
	}

	// Стабільний id: повторна доставка того самого повідомлення не створює другу сесію й другу відповідь.
	const id = `tg-${chat}-${msg.message_id}`;
	if (await agent.link(id)) {
		console.log(`telegram ${chat}/${msg.message_id}: duplicate delivery, session ${id} already exists`);
		return;
	}

	const transcript = (await transcribe(env, llm, file, text)) || (image ? IMAGE_ONLY : "");
	if (!transcript) return void (await say("⚠️ Не розібрав голос, надішли ще раз чи напиши текстом."));
	// Явний префікс сильніший за здогад репозиторію; назву для теки/гілки модель придумує завжди. У пості видно, що вибрано.
	const { task, model: requestedModel, sure: forcedSure, silpo: forcedSilpo, calendar: forcedCalendar, cloudflare } = parsePrefixes(transcript);
	const withRepo = REPO_PREFIX.exec(task);
	const prompt = withRepo ? withRepo[2].trim() : task;
	const route = await routeTask(llm, withRepo ? [] : repos, prompt);
	const repo = withRepo ? withRepo[1] : route.repo;
	// Sure підключається, коли власник назвав його явно («шур, …», «@sure») або модель побачила, що задача про його фінанси.
	const sure = forcedSure || route.sure === true;
	// Сільпо так само: явно («сільпо, …», «@silpo») або модель побачила, що треба дивитись, що власник купував у магазині.
	const silpo = forcedSilpo || route.silpo === true;
	// Календар так само: явно («календар, …», «@calendar») або модель побачила, що треба дивитись чи міняти події власника.
	const calendar = forcedCalendar || route.calendar === true;
	// Задачі з даними Sure, Сільпо чи Календаря прості (вибірка й підсумки): за замовчуванням haiku, якщо власник не назвав модель сам.
	const model = requestedModel ?? route.model ?? (sure || silpo || calendar ? "haiku" : undefined);
	const pending: Pending = { id, chat, messageId: msg.message_id, inChannel, ...(threadId && { threadId }), voice: !!file, image: !!image, prompt, route, ...(model && { model }), sure, silpo, calendar, cloudflare, ...(images && { images }) };
	// Роутер не впевнений, чи це про відомий репозиторій (і про який): питаємо кнопками замість того, щоб вгадувати.
	if (!repo && route.unsure) return void (await askRepo(env, agent, repos, pending));
	await launchSession(env, agent, pending, repo);
}

// Слова, які Whisper часто псує в диктовці задач («Opus» → «опис», «воркер» → «ворки»): іде йому як initial_prompt.
const VOICE_HINT = "Opus, Sonnet, Haiku, Sure, Сільпо, Google Calendar, Cloudflare MCP, воркер, агент, бот, репозиторій, pull request, Cloudflare, Telegram.";

// Голосове → текст через Whisper; текст як є. Порожній рядок — не розібрали.
async function transcribe(env: BotEnv, llm: Llm, file: { file_id: string; mime_type?: string } | undefined, text: string | undefined): Promise<string> {
	if (!file) return text ?? "";
	const { data } = await downloadTelegramFile(env, file.file_id);
	return llm.transcribe(data, file.mime_type ?? "audio/ogg", VOICE_HINT);
}

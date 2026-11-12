import { DOWNLOAD_MAX_BYTES, react, safeEqual, tg, tgSendMessage, type BotEnv, type Llm, type TgMessage, type TgUpdate } from "@voice-notes/core";
import { folderFor, type Agent } from "../../domain/agent";
import type { Env } from "../../env";
import { QUOTE_CLOSE, QUOTE_OPEN, removeMessage, sayTemporarily, sendChat } from "../../infrastructure/chat";
import { handleButton } from "./buttons";
import { quotaText, sessionCommand, updateContainer, type Say } from "./commands";
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
	if (deps.syncCommands) deps.defer(syncCommands(bot));
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
			handleMessage(bot, msg, inChannel, deps, env.CLAUDE_CODE_OAUTH_TOKEN).catch(async (err) => {
				console.error("telegram message failed:", err);
				await tgSendMessage(bot, msg.chat.id, "⚠️ Не вдалося створити сесію, спробуй ще раз.").catch(() => {});
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

async function handleMessage(env: BotEnv, msg: TgMessage, inChannel: boolean, { agent, llm, repos = [], sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }: TelegramDeps, claudeToken?: string): Promise<void> {
	const chat = msg.chat.id;
	const file = msg.voice ?? msg.audio;
	const text = msg.text?.trim();
	const replied = SESSION_URL.exec(textWithLinks(msg.reply_to_message));
	const say = (t: string) => tgSendMessage(env, chat, t);
	const cleanups: Promise<unknown>[] = [];
	const sayTemp: Say = (t) => sayTemporarily(env, chat, t, sleep, cleanups);

	if (!file && (!text || text.startsWith("/"))) {
		const command = text?.split(/[\s@]/)[0];
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
	const withModel = modelPrefix(transcript);
	const task = withModel ? withModel.task.trim() : transcript;
	const model = withModel?.model;
	const withRepo = REPO_PREFIX.exec(task);
	const prompt = withRepo ? withRepo[2].trim() : task;
	const route = await routeTask(llm, withRepo ? [] : repos, prompt);
	const repo = withRepo ? withRepo[1] : route.repo;

	const url = agent.url(id);
	// У каналі оригінал замінюється постом із задачею (як у нотатках), у приваті оригінал лишається, тож задачу не дублюємо.
	const clipped = prompt.length > POST_MAX ? `${prompt.slice(0, POST_MAX)}…` : prompt;
	// Без прев'ю: інакше Telegram показує картку сторінки за Access.
	// Один пост на сесію: агент оновлює його на місці (⏳ Працює → підсумок), нових повідомлень про стан немає.
	// Розшифровка голосового — згорнута цитата під репозиторієм (її не диктували, місця не займає); текст показується як є.
	// Гілка agent/<тека> є лише в сесії з репозиторієм.
	const where = [repo ? `📦 ${repo}\n🌿 agent/${folderFor(id, route.name)}` : "", model ? `🤖 ${model}` : ""].filter(Boolean).join("\n");
	const header = (
		file ? [where, `${QUOTE_OPEN}🗣 ${clipped}${QUOTE_CLOSE}`].filter(Boolean).join("\n\n")
		: `${inChannel ? `${clipped}\n\n` : ""}${where}`
	).trim();
	const postId = await sendChat(env, chat, [header, "⏳ Запускаю"].filter(Boolean).join("\n\n"), url, "working");
	// Запуск (холодний старт контейнера, клон) іде в Durable Object і не залежить від життя цього запиту; збій він покаже в пості.
	await agent.begin(id, { prompt, ...(repo && { repo }), ...(route.name && { name: route.name }), ...(model && { model }) }, { chatId: chat, url, postId, header });
	// Пост уже містить задачу (для голосового — транскрипт), тож оригінал прибираємо; лишається лише приватний текст.
	if (inChannel || file) await removeMessage(env, chat, msg.message_id);
}

// Голосове → текст через Whisper; текст як є. Порожній рядок — не розібрали.
async function transcribe(env: BotEnv, llm: Llm, file: { file_id: string; mime_type?: string } | undefined, text: string | undefined): Promise<string> {
	if (!file) return text ?? "";
	const info = await tg(env, "getFile", { file_id: file.file_id });
	const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
	if (!res.ok) throw new Error(`download ${res.status}`);
	return llm.transcribe(await res.arrayBuffer(), file.mime_type ?? "audio/ogg");
}

import { tg, tgSendMessage, type BotEnv } from "@voice-notes/core";
import { folderFor, type Agent, type ImageRef } from "../../domain/agent";
import { QUOTE_CLOSE, QUOTE_OPEN, callback, createTopic, removeMessage, sendChat } from "../../infrastructure/chat";
import { type Stopwatch } from "../../timing";
import type { KnownRepo, Route } from "./repo";

const POST_MAX = 3500; // запас до ліміту повідомлення Telegram (4096): решта — посилання

// Усе, що потрібно, щоб запустити нову сесію з повідомлення: звичайно запуск іде одразу, а коли репозиторій невідомий
// і роутер не впевнений, задача чекає вибору кнопкою (див. askRepo) і зберігається в цій самій формі.
export type Pending = {
	id: string; // id нової сесії (tg-<чат>-<повідомлення>)
	chat: number;
	messageId: number; // оригінальне повідомлення власника
	inChannel: boolean;
	threadId?: number;
	voice: boolean; // задача продиктована голосом (у пості її розшифровка в цитаті)
	image: boolean;
	prompt: string;
	route: Route;
	model?: string;
	sure: boolean;
	silpo: boolean;
	calendar: boolean;
	cloudflare: boolean;
	images?: ImageRef[];
};

// Створює пост і сесію (тему в приватному чаті, пост із ⏳, begin в агента). repo — вибраний чи розпізнаний репозиторій.
export async function launchSession(env: BotEnv, agent: Agent, p: Pending, repo: string | undefined, sw?: Stopwatch): Promise<void> {
	const { id, chat, messageId, inChannel, threadId, voice: file, image: hasImage, prompt, route, model, sure, silpo, calendar, cloudflare, images } = p;
	console.log(`telegram ${chat}/${messageId}: new session ${id} repo=${repo ?? "-"} model=${model ?? "-"} sure=${sure} silpo=${silpo} calendar=${calendar} cloudflare=${cloudflare}`);
	const url = agent.url(id);
	// Приватний чат: кожна нова сесія отримує свою тему, і далі розмова йде в ній. Теми не ввімкнено (чи збій) — усе в самому чаті.
	// Повідомлення з уже наявної, не прив'язаної до сесії теми лишається в ній.
	// Назва теми — семантична (від моделі), далі її оновлює агент, коли напрям розмови змінюється.
	const title = route.title ?? route.name ?? prompt.replace(/\s+/g, " ").slice(0, 60);
	const created = !inChannel && !threadId ? await createTopic(env, chat, title) : undefined;
	sw?.mark("topic");
	const thread = created ?? threadId;
	// У каналі й у новій темі оригінал замінюється постом із задачею (як у нотатках), у приваті без теми оригінал лишається, тож задачу не дублюємо.
	// Фото теж замінюється постом (підпис до нього — текст задачі в пості), тому вважається «перенесеним».
	const moved = inChannel || !!created || hasImage;
	const clipped = prompt.length > POST_MAX ? `${prompt.slice(0, POST_MAX)}…` : prompt;
	// Без прев'ю: інакше Telegram показує картку сторінки за Access.
	// Один пост на сесію: агент оновлює його на місці (⏳ Працює → підсумок), нових повідомлень про стан немає.
	// Розшифровка голосового — згорнута цитата під репозиторієм (її не диктували, місця не займає); текст показується як є.
	// Гілка agent/<тека> є лише в сесії з репозиторієм.
	const where = [repo ? `📦 ${repo}\n🌿 agent/${folderFor(id, route.name)}` : "", model ? `🤖 ${model}` : "", sure ? "💰 Sure" : "", silpo ? "🛒 Сільпо" : "", calendar ? "📅 Календар" : "", cloudflare ? "☁️ Cloudflare" : ""].filter(Boolean).join("\n");
	const header = (
		file ? [where, `${QUOTE_OPEN}🗣 ${clipped}${QUOTE_CLOSE}`].filter(Boolean).join("\n\n")
		: `${moved ? `${clipped}\n\n` : ""}${where}`
	).trim();
	const postId = await sendChat(env, chat, [header, "⏳ Запускаю"].filter(Boolean).join("\n\n"), url, "working", undefined, undefined, thread);
	sw?.mark("post");
	// Запуск (холодний старт контейнера, клон) іде в Durable Object і не залежить від життя цього запиту; збій він покаже в пості.
	await agent.begin(id, { prompt, ...(repo && { repo }), ...(route.name && { name: route.name }), ...(model && { model }), ...(sure && { sure }), ...(silpo && { silpo }), ...(calendar && { calendar }), ...(cloudflare && { cloudflare }), ...(images && { images }) }, { chatId: chat, url, postId, header, ...(thread && { threadId: thread }), ...(created && { title }) });
	sw?.mark("begin");
	// Пост уже містить задачу (для голосового — транскрипт), тож оригінал прибираємо; лишається лише приватний текст без теми.
	if (moved || file) await removeMessage(env, chat, messageId);
	// Сільпо потрібне, а входу ще немає: одразу даємо посилання на вхід (агент про це теж скаже, але без повної адреси).
	if (silpo && !(await agent.silpoConnected().catch(() => true))) await tgSendMessage(env, chat, `🛒 Сільпо ще не підключено. Увійди тут, потім повтори задачу: ${new URL(url).origin}/silpo/login`, thread);
	if (calendar && !(await agent.calendarConnected().catch(() => true))) await tgSendMessage(env, chat, `📅 Календар ще не підключено. Увійди тут, потім повтори задачу: ${new URL(url).origin}/calendar/login`, thread);
	if (cloudflare && !(await agent.cloudflareConnected().catch(() => true))) await tgSendMessage(env, chat, `☁️ Cloudflare ще не підключено. Увійди тут, потім повтори задачу: ${new URL(url).origin}/cloudflare/login`, thread);
}

const pickKey = (id: string) => `pick:${id}`;
type Saved = Pending & { choices: string[] };

// Роутер не впевнений, чи задача про відомий репозиторій (і про який): сесію не стартуємо, а питаємо кнопками. Задача
// чекає у сховищі агента (saveRef) до натискання; невибране нічого не коштує й не створює.
export async function askRepo(env: BotEnv, agent: Agent, repos: KnownRepo[], p: Pending): Promise<void> {
	const choices = repos.map((r) => r.repo);
	const rows = [...choices.map((name, i) => [{ text: `📦 ${name}`, callback_data: callback.pick(p.id, i) }]), [{ text: "Без репозиторію", callback_data: callback.pick(p.id, "none") }]];
	const brief = p.prompt.replace(/\s+/g, " ").slice(0, 200);
	const sent = await tg(env, "sendMessage", { chat_id: p.chat, ...(p.threadId && { message_thread_id: p.threadId }), text: `📦 До якого репозиторію ця задача?\n\n«${brief}»`, reply_markup: { inline_keyboard: rows } });
	await agent.saveRef(pickKey(p.id), { chatId: p.chat, messageId: sent.message_id, text: JSON.stringify({ ...p, choices } satisfies Saved) });
}

// Кнопка вибору: забирає збережену задачу (повторне натискання вже нічого не знайде) і запускає сесію з вибраним репозиторієм.
// false — вибір неактуальний (уже натиснуто чи невідомий номер).
export async function resolveRepo(env: BotEnv, agent: Agent, id: string, choice: number | "none", pickerId: number): Promise<boolean> {
	const ref = await agent.takeRef(pickKey(id));
	if (!ref) return false;
	const { choices, ...p } = JSON.parse(ref.text) as Saved;
	const repo = choice === "none" ? undefined : choices[choice];
	if (choice !== "none" && !repo) return false;
	await removeMessage(env, p.chat, pickerId);
	await launchSession(env, agent, p, repo);
	return true;
}

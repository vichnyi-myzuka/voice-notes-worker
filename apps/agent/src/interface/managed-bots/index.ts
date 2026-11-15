import { safeEqual, tg, type BotEnv, type TgManagedBot, type TgMessage } from "@voice-notes/core";
import type { Env } from "../../env";

// PoC «бот на сесію» (Telegram Managed Bots, Bot API 9.6). Менеджер — основний бот (BOT_TOKEN, у BotFather увімкнено Bot Management Mode).
// 1) /newbot у приваті → посилання t.me/newbot/<менеджер>/<юзернейм>: власник мусить сам натиснути «Створити» (бот не може створити бота сам);
// 2) апдейт `managed_bot` на основний вебхук → ставимо новому боту вебхук на /managed/<id> із секретом, виведеним з TG_WEBHOOK_SECRET;
// 3) повідомлення новому боту від власника → луна. Токен дитини ніде не зберігаємо: щоразу беремо його в менеджера (getManagedBotToken).
export const MANAGED_PATH = "/managed/";

const tokens = new Map<number, string>(); // кеш у межах екземпляра воркера

async function managedToken(bot: BotEnv, botId: number): Promise<string> {
	const cached = tokens.get(botId);
	if (cached) return cached;
	const token = await tg(bot, "getManagedBotToken", { user_id: botId });
	tokens.set(botId, token);
	return token;
}

// Секрет вебхука дитини: HMAC-SHA256(TG_WEBHOOK_SECRET, "managed:<id>") у hex (дозволений Telegram набір символів).
async function webhookSecret(env: Env, botId: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TG_WEBHOOK_SECRET ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`managed:${botId}`));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// /newbot: надсилає власнику кнопку-посилання на створення бота (юзернейм і ім'я він може змінити на екрані підтвердження).
export async function sendNewBotLink(bot: BotEnv, chatId: number): Promise<void> {
	const manager = (await tg(bot, "getMe", {})).username;
	if (!manager) throw new Error("manager bot has no username");
	const suggested = `agent_${Math.random().toString(36).slice(2, 8)}_bot`;
	const url = `https://t.me/newbot/${manager}/${suggested}?name=${encodeURIComponent("Агент: сесія")}`;
	await tg(bot, "sendMessage", { chat_id: chatId, text: "Натисни, щоб створити бота для сесії (Telegram попросить підтвердити).", reply_markup: { inline_keyboard: [[{ text: "➕ Створити бота", url }]] } });
}

// Апдейт `managed_bot`: лише від власника. Ставить новому боту вебхук і пише власнику, що він готовий.
export async function handleManagedBotCreated(bot: BotEnv, env: Env, managed: TgManagedBot, origin: string): Promise<void> {
	if (!env.TG_OWNER_ID || String(managed.user.id) !== env.TG_OWNER_ID) return console.log(`managed bot ${managed.bot.id}: ignored, not the owner`);
	const child = { BOT_TOKEN: await managedToken(bot, managed.bot.id) };
	await tg(child, "setWebhook", { url: `${origin}${MANAGED_PATH}${managed.bot.id}`, secret_token: await webhookSecret(env, managed.bot.id), allowed_updates: ["message"] });
	await tg(bot, "sendMessage", { chat_id: managed.user.id, text: `✅ Бот ${managed.bot.username ? `@${managed.bot.username}` : managed.bot.id} створено. Напиши йому щось.` });
	console.log(`managed bot ${managed.bot.id}: webhook set`);
}

// Вебхук керованого бота (/managed/<id>): секретний заголовок, далі лише власник. PoC відповідає луною.
export async function handleManagedWebhook(req: Request, env: Env, defer: (work: Promise<unknown>) => void): Promise<Response> {
	const botId = Number(new URL(req.url).pathname.slice(MANAGED_PATH.length));
	const header = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (req.method !== "POST" || !env.TG_WEBHOOK_SECRET || !env.BOT_TOKEN || !Number.isSafeInteger(botId) || botId <= 0 || !(await safeEqual(header, await webhookSecret(env, botId)))) {
		return new Response("unauthorized", { status: 401 });
	}
	const msg = (await req.json<{ message?: TgMessage }>().catch(() => null))?.message;
	if (msg?.text && msg.chat.type === "private" && String(msg.from?.id) === env.TG_OWNER_ID) {
		defer(
			managedToken({ BOT_TOKEN: env.BOT_TOKEN }, botId)
				.then((token) => tg({ BOT_TOKEN: token }, "sendMessage", { chat_id: msg.chat.id, text: `🤖 Луна з бота-сесії: «${msg.text}»` }))
				.catch((err) => console.error("managed bot reply failed:", err)),
		);
	}
	return new Response("ok");
}

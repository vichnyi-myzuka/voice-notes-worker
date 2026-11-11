// Лише токен бота: для методів Bot API, що не потребують каналу (наприклад, чат агента без CHAT_ID).
export type BotEnv = Pick<TelegramEnv, "BOT_TOKEN">;

// Що потрібно адаптеру Telegram від середовища воркера.
export type TelegramEnv = { BOT_TOKEN: string; CHAT_ID: string; TG_WEBHOOK_SECRET?: string; TG_OWNER_ID?: string };

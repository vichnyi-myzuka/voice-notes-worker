// Що потрібно адаптеру Telegram від середовища воркера.
export type TelegramEnv = { BOT_TOKEN: string; CHAT_ID: string; TG_WEBHOOK_SECRET?: string; TG_OWNER_ID?: string };

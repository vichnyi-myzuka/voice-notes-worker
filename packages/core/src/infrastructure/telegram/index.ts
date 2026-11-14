// Telegram: адаптер каналу (Channel), Bot API, прийом голосових, тексту й фото з вебхука.

export { CAPTION_MAX, TEXT_CAPTION_MAX, telegramChannel, textNote } from "./channel";
export { DOWNLOAD_MAX_BYTES, react, receiveTelegramMessage } from "./receive";
export { NO_PREVIEW, downloadTelegramFile, telegramMessageUrl, tg, tgSendMessage, tgSendNote } from "./api";
export type { ReceivedMessage, TgCallbackQuery, TgInlineKeyboard, TgMessage, TgUpdate } from "./types";
export type { BotEnv, TelegramEnv } from "./env";

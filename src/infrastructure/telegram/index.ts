// Telegram: адаптер каналу (Channel), Bot API, прийом голосових, тексту й фото з вебхука.

export { CAPTION_MAX, TEXT_CAPTION_MAX, telegramChannel, textNote } from "./channel";
export { receiveTelegramMessage } from "./receive";
export { telegramMessageUrl, tgSendNote } from "./api";
export type { ReceivedMessage } from "./types";

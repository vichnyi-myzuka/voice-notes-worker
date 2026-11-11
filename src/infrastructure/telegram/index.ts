// Bot API і прийом голосових, тексту й фото з вебхука.

export { NO_PREVIEW, deleteOriginal, markEditing, tg, tgSendMessage, tgSendNote, tgSendText } from "./api";
export { receiveTelegramMessage } from "./receive";
export type { ReceivedMessage, TgEntity, TgTextLink, TgUpdate } from "./types";
export { telegramMessageUrl } from "./api";

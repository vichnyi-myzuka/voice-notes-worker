// Bot API і прийом голосових, тексту й фото з вебхука.

export { NO_PREVIEW, deleteOriginal, markEditing, tg, tgSendMessage, tgSendNote, tgSendText } from "./api";
export { receiveTelegramVoice } from "./receive";
export type { ReceivedVoice } from "./types";
export { telegramMessageUrl } from "./utils";

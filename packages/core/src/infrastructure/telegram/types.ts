export type TgFile = { file_id: string; file_size?: number; mime_type?: string };

export type TgMessage = {
	message_id: number;
	date: number;
	chat: { id: number; type: string };
	from?: { id: number };
	text?: string;
	caption?: string;
	voice?: TgFile;
	audio?: TgFile;
	photo?: TgFile[]; // розміри від меншого до більшого
	// Telegram віддає повідомлення, на яке відповіли, разом із текстом: так бот агента знаходить сесію за посиланням у пості.
	// entities: у клікабельного слова адреса лежить у text_link.url, а не в тексті
	reply_to_message?: { message_id: number; text?: string; caption?: string; entities?: { type: string; url?: string }[]; caption_entities?: { type: string; url?: string }[] };
};

export type ReceivedMessage = {
	contentType: string;
	fileId?: string; // для тексту немає
	kind: string; // voice | audio | text | photo
	caption?: string; // підпис до фото: іде в модель разом із зображенням
	// Голосове з каналу видаляється після публікації нотатки: нотатка містить те саме аудіо.
	deleteChatId?: string;
	deleteMessageId?: string;
	// Відповідь голосовим на нотатку в каналі: інструкція редагування цієї нотатки.
	replyTo?: string;
};

// Куди передати прийняте повідомлення (кладе запис у R2 і чергу).
// Повертає false, якщо повідомлення вже прибране (правка): тоді ✍ не ставимо.
export type StoreMessage = (key: string, body: ArrayBuffer, message: ReceivedMessage) => Promise<boolean>;

// Сутності тексту: посилання на задачі й розгортувана цитата оригіналу.
export type TgTextLink = { type: "text_link"; offset: number; length: number; url: string };
export type TgEntity = TgTextLink | { type: "expandable_blockquote"; offset: number; length: number };

type ChatId = string | number;
type MessageRef = { message_id: number };
// Inline-кнопки під повідомленням: callback_data (до 64 байт) повертається боту в callback_query.
export type TgInlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

// Методи Bot API, які використовує воркер: параметри й результат. Ключі — назви методів.
export type TgMethods = {
	sendMessage: {
		params: { chat_id: ChatId; text: string; parse_mode?: "HTML"; entities?: TgEntity[]; link_preview_options?: { is_disabled: boolean }; reply_markup?: TgInlineKeyboard };
		result: MessageRef;
	};
	sendAudio: { params: { chat_id: ChatId; audio: string; title: string; caption: string }; result: MessageRef };
	sendVoice: { params: { chat_id: ChatId; voice: string; caption: string }; result: MessageRef };
	sendPhoto: { params: { chat_id: ChatId; photo: string; caption: string }; result: MessageRef };
	editMessageText: {
		params: { chat_id: ChatId; message_id: number; text: string; parse_mode?: "HTML"; entities?: TgEntity[]; link_preview_options?: { is_disabled: boolean }; reply_markup?: TgInlineKeyboard };
		result: MessageRef;
	};
	editMessageReplyMarkup: { params: { chat_id: ChatId; message_id: number; reply_markup: TgInlineKeyboard }; result: MessageRef };
	editMessageCaption: {
		params: { chat_id: ChatId; message_id: number; caption: string; caption_entities: TgEntity[] };
		result: MessageRef;
	};
	answerCallbackQuery: { params: { callback_query_id: string; text?: string }; result: boolean };
	deleteMessage: { params: { chat_id: ChatId; message_id: number }; result: boolean };
	setMyCommands: { params: { commands: { command: string; description: string }[]; scope?: { type: "all_private_chats" } }; result: boolean };
	setMessageReaction: {
		params: { chat_id: ChatId; message_id: number; reaction: { type: "emoji"; emoji: string }[] };
		result: boolean;
	};
	getFile: { params: { file_id: string }; result: { file_path: string } };
};

// Натискання inline-кнопки: хто натиснув, під яким повідомленням і що було в callback_data.
export type TgCallbackQuery = { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type: string }; text?: string }; data?: string };

// Оновлення з вебхука: повідомлення (приват), дописи каналу й натискання кнопок.
export type TgUpdate = { message?: TgMessage; channel_post?: TgMessage; callback_query?: TgCallbackQuery };

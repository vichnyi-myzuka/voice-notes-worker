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
	reply_to_message?: { message_id: number };
};

export type ReceivedVoice = {
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

import type { Meta } from "../note";
import type { TriageItem } from "../todoist";

// Опублікована нотатка: запис у R2 для редагування (`notes/<id>.json`, 7 днів за lifecycle бакета)
// і її повідомлення в каналі. Тут живуть ключі R2 і оновлення повідомлення; решта коду їх не знає.
// `notes/msg-<message_id>` вказує на id нотатки: так відповідь у каналі знаходить, що редагувати.
export type Note = {
	transcript: string;
	edits: string[]; // інструкції попередніх редагувань
	meta: Meta;
	triage: TriageItem[] | null;
	messageId: number;
	recordedTs: number;
	text?: boolean; // текстова нотатка: повідомлення без аудіо, оригінал — у цитаті під підписом
	setup?: string[]; // зміни налаштувань Todoist, зроблені цією нотаткою та її правками (для підпису)
};

// Слайс стану обробки: публікація в канал (див. state.ts).
export type PublishState = {
	noteId?: string; // id нотатки для редагування й задач Todoist, створюється до відправки
	messageId?: number; // id повідомлення нотатки в Telegram
	audioSent?: boolean; // (завеликий файл) оригінал відправлено без транскрипту
	todoistMarked?: boolean; // підпис з посиланнями на задачі оновлено після виконання
	photoAttached?: boolean; // (фото) фото додане коментарем до створених задач
	originalDeleted?: boolean; // оригінальне голосове з каналу видалене
	captionEdited?: boolean; // (редагування) підпис нотатки вже оновлено
};

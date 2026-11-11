// Прив'язки й змінні воркера (див. wrangler.toml і секрети в README).
export interface Env {
	AI: Ai;
	BUCKET: R2Bucket;
	QUEUE: Queue<Job>;
	// secrets
	SECRET: string;
	OPENAI_KEY?: string; // для gpt-6-luna; без нього одразу Gemma
	BOT_TOKEN: string;
	CHAT_ID: string; // куди надсилати нотатки (канал)
	TG_WEBHOOK_SECRET?: string; // секрет вебхука Telegram
	TG_OWNER_ID?: string; // Telegram user id власника: голосові в приваті й натискання кнопок
	TODOIST_TOKEN?: string; // без нього нотатки йдуть без тріажу задач
	// vars
	TIMEZONE: string;
	LOCAL_DEV?: string; // ставиться лише в `npm run dev`
}

// edit: id нотатки, яку редагує цей запис (замість створення нової).
export type Job = { key: string; edit?: string };

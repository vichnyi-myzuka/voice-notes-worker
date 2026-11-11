// Тіла запитів і відповідей Todoist API (/sync), які використовує адаптер.
// undefined у об'єктах JSON.stringify пропускає, тож необов'язкові поля можна передавати як є.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

export type TodoistCommand = { type: string; uuid: string; temp_id?: string; args: { [key: string]: Json | undefined } };

export type CommandStatus = "ok" | { error_tag?: string; error?: string; error_code?: number };

export type SyncResult = { sync_status: Record<string, CommandStatus>; temp_id_mapping: Record<string, string> };

// Статуси команд, які Todoist не прийняв, як рядки для повідомлення про помилку.
export const rejected = (status: Record<string, CommandStatus>): string[] =>
	Object.values(status)
		.filter((s) => s !== "ok")
		.map((s) => JSON.stringify(s));



// Підпис до фото — окремим об'єктом: у customMetadata R2 (2 КБ) 1024 символи кирилиці можуть не влізти.
export const captionKey = (key: string) => `${key}.caption`;

// Проміжний стан обробки запису (див. openSteps): поруч із самим записом.
export const stateKey = (key: string) => `${key}.state.json`;

export function recordedTs(key: string): number {
	return Number(key.split("-")[0]);
}

export function formatRecordedAt(key: string, timeZone: string): string {
	// sv-SE дає формат "2026-11-09 14:30"
	return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(recordedTs(key)));
}

// Whisper у Workers AI працює ~9x швидше за реальний час, а consumer має 15 хв wall time.
// 25 MB це ~50 хв аудіо iPhone (~64 kbps) або ~100 хв при 32 kbps, тобто з запасом.
export const TRANSCRIBE_MAX_BYTES = 25_000_000;

export const TELEGRAM_MAX_BYTES = 50_000_000; // ліміт Bot API на upload: 50 MB

// Дата у форматі YYYY-MM-DD у часовому поясі.
export function isoDate(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date);
}

// Дата для промпту: "2026-11-09 (понеділок, 09.11.2026)".
export function promptDate(date: Date, timeZone: string): string {
	const long = new Intl.DateTimeFormat("uk-UA", { timeZone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	return `${isoDate(date, timeZone)} (${long})`;
}

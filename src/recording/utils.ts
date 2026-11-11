// Підпис до фото — окремим об'єктом: у customMetadata R2 (2 КБ) 1024 символи кирилиці можуть не влізти.
export const captionKey = (key: string) => `${key}.caption`;

export function recordedTs(key: string): number {
	return Number(key.split("-")[0]);
}

export function formatRecordedAt(key: string, timeZone: string): string {
	// sv-SE дає формат "2026-11-09 14:30"
	return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(recordedTs(key)));
}

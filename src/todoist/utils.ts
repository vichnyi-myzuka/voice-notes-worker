// Дата у форматі YYYY-MM-DD у часовому поясі.
export function isoDate(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date);
}

// Дата для промпту: "2026-11-09 (понеділок, 09.11.2026)".
export function promptDate(date: Date, timeZone: string): string {
	const long = new Intl.DateTimeFormat("uk-UA", { timeZone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	return `${isoDate(date, timeZone)} (${long})`;
}

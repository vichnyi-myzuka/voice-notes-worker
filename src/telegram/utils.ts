
// Посилання на повідомлення є лише в каналах і супергрупах (chat_id вигляду -100…).
export function telegramMessageUrl(chatId: string, messageId: number): string | null {
	return chatId.startsWith("-100") ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null;
}

export function safeFileName(name: string): string {
	const clean = name
		// oxlint-disable-next-line no-control-regex -- керівні символи в назві файлу прибираємо навмисно
		.replace(/[/\\:*?"<>|\x00-\x1f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return clean || "voice-note";
}

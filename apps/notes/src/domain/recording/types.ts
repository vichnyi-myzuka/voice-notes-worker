// Порт сховища записів (зараз R2): сирий запис, підпис до фото і проміжний стан обробки. Ключі й формат зберігання знає лише адаптер.

// Запис, що чекає обробки.
export type Recording = {
	size: number;
	contentType: string; // за замовчуванням audio/mp4
	metadata?: Record<string, string>; // службові дані каналу (fileId, deleteChatId…): ядро передає їх каналу як є
	text(): Promise<string>;
	bytes(): Promise<ArrayBuffer>; // тіло читається один раз, далі кешується
};

export type RecordingStore = {
	put(key: string, body: ArrayBuffer, info: { contentType: string; metadata: Record<string, string> }): Promise<void>;
	get(key: string): Promise<Recording | null>;
	putCaption(key: string, caption: string): Promise<void>;
	caption(key: string): Promise<string>; // порожній рядок, якщо підпису немає
	// Прибирає запис разом із підписом і станом обробки (`stateKey`).
	remove(key: string): Promise<void>;
};

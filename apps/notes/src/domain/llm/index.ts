// Порт мовних моделей: structured output і розпізнавання мови. Реалізація — infrastructure/llm.

import type { JsonObject } from "../json";

export type JsonRequest = {
	name: string; // ім'я схеми та мітка в логах
	system: string;
	user: string;
	schema: JsonObject;
	reasoning?: "none" | "low"; // для моделей з reasoning
	image?: { data: ArrayBuffer; type: string }; // зображення до user-повідомлення
};

export type Llm = {
	// Розібраний результат або null, якщо не впоралась жодна модель.
	askJson<T>(req: JsonRequest, parse: (text: string) => T): Promise<T | null>;
	// Аудіо (m4a з шорткату, ogg/opus з каналу) → текст українською.
	transcribe(audio: ArrayBuffer, contentType: string): Promise<string>;
};

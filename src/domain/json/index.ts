// JSON-значення: відповіді моделей і схеми structured output. Спільні для всіх шарів.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// Звужує значення з відповіді моделі до об'єкта.
export const isJsonObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

// Розбирає перший JSON-об'єкт у тексті (модель може обгорнути його поясненнями).
export function parseJsonObject(text: string): JsonObject {
	return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

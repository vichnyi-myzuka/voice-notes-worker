// Один запит зі structured output: спершу gpt-6-luna, при будь-якій помилці
// (API, немає кредитів/ключа, невалідна відповідь) — Gemma 4 у Workers AI.
export type JsonRequest = {
	name: string; // ім'я схеми та мітка в логах
	system: string;
	user: string;
	schema: object;
	reasoning?: "none" | "low"; // для Luna; Gemma завжди без reasoning
	image?: { base64: string; type: string }; // зображення до user-повідомлення (обидві моделі вміють vision)
};

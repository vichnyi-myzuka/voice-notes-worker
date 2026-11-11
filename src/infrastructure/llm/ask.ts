import type { Env } from "../env";

// JSON-значення: відповіді моделей і схеми structured output.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// Звужує значення з відповіді моделі до об'єкта.
export const isJsonObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

// Повертає розібраний результат або null, якщо не впоралась жодна модель.
export async function askJson<T>(env: Env, req: JsonRequest, parse: (text: string) => T): Promise<T | null> {
	const models: [string, (env: Env, req: JsonRequest) => Promise<string>][] = [
		["gpt-6-luna", askLuna],
		["gemma-4", askGemma],
	];
	for (const [model, ask] of models) {
		let text = "";
		try {
			text = await ask(env, req);
			const result = parse(text);
			console.log(`${req.name} by ${model}`);
			return result;
		} catch (err) {
			console.error(`${req.name}: ${model} failed:`, err, text);
		}
	}
	return null;
}

// Один запит зі structured output: спершу gpt-6-luna, при будь-якій помилці
// (API, немає кредитів/ключа, невалідна відповідь) — Gemma 4 у Workers AI.
export type JsonRequest = {
	name: string; // ім'я схеми та мітка в логах
	system: string;
	user: string;
	schema: JsonObject;
	reasoning?: "none" | "low"; // для Luna; Gemma завжди без reasoning
	image?: { base64: string; type: string }; // зображення до user-повідомлення (обидві моделі вміють vision)
};

// ArrayBuffer → base64 частинами (String.fromCharCode з великим масивом переповнює стек).
export function toBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export const dataUrl = (image: NonNullable<JsonRequest["image"]>) => `data:${image.type};base64,${image.base64}`;

// Витягує перший JSON-об'єкт з відповіді моделі.
export function parseJsonObject(text: string): JsonObject {
	return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

export async function askLuna(env: Env, req: JsonRequest): Promise<string> {
	if (!env.OPENAI_KEY) throw new Error("OPENAI_KEY is not set");
	const res = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: "gpt-6-luna",
			reasoning: { effort: req.reasoning ?? "none" },
			max_output_tokens: 4096,
			input: [
				{ role: "system", content: req.system },
				{
					role: "user",
					content: req.image
						? [
								{ type: "input_text", text: req.user },
								{ type: "input_image", image_url: dataUrl(req.image) },
							]
						: req.user,
				},
			],
			text: { format: { type: "json_schema", name: req.name, schema: req.schema, strict: true } },
		}),
	});
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
	const data = await res.json<{ output: { type: string; content?: { type: string; text?: string }[] }[] }>();
	return data.output
		.filter((o) => o.type === "message")
		.flatMap((o) => o.content ?? [])
		.filter((c) => c.type === "output_text")
		.map((c) => c.text ?? "")
		.join("");
}

export async function askGemma(env: Env, req: JsonRequest): Promise<string> {
	const res = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
		messages: [
			{ role: "system", content: req.system },
			{
				role: "user",
				content: req.image
					? [
							{ type: "text", text: req.user },
							{ type: "image_url", image_url: { url: dataUrl(req.image) } },
						]
					: req.user,
			},
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: req.name, schema: req.schema, strict: true },
		},
		chat_template_kwargs: { enable_thinking: false },
		max_completion_tokens: 4096,
	});
	// Структуровану відповідь модель може віддати як рядок або вже як об'єкт (чи в полі response, як старі моделі).
	const out: { choices?: { message?: { content?: Json | null } }[]; response?: Json } = res;
	const content = out.choices?.[0]?.message?.content ?? out.response ?? "";
	return typeof content === "string" ? content : JSON.stringify(content);
}

import type { Env } from "./index";

// Один запит зі structured output: спершу gpt-6-luna, при будь-якій помилці
// (API, немає кредитів/ключа, невалідна відповідь) — Gemma 4 у Workers AI.
export type JsonRequest = {
	name: string; // ім'я схеми та мітка в логах
	system: string;
	user: string;
	schema: object;
	reasoning?: "none" | "low"; // для Luna; Gemma завжди без reasoning
};

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

// Витягує перший JSON-об'єкт з відповіді моделі.
export function parseJsonObject(text: string): Record<string, unknown> {
	return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

async function askLuna(env: Env, req: JsonRequest): Promise<string> {
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
				{ role: "user", content: req.user },
			],
			text: { format: { type: "json_schema", name: req.name, schema: req.schema, strict: true } },
		}),
	});
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { output: { type: string; content?: { type: string; text?: string }[] }[] };
	return data.output
		.filter((o) => o.type === "message")
		.flatMap((o) => o.content ?? [])
		.filter((c) => c.type === "output_text")
		.map((c) => c.text ?? "")
		.join("");
}

async function askGemma(env: Env, req: JsonRequest): Promise<string> {
	const res = (await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
		messages: [
			{ role: "system", content: req.system },
			{ role: "user", content: req.user },
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: req.name, schema: req.schema, strict: true },
		},
		chat_template_kwargs: { enable_thinking: false },
		max_completion_tokens: 4096,
	} as never)) as { choices?: { message?: { content?: unknown } }[]; response?: unknown };
	// Структуровану відповідь модель може віддати як рядок або вже як об'єкт.
	const content = res.choices?.[0]?.message?.content ?? res.response ?? "";
	return typeof content === "string" ? content : JSON.stringify(content);
}

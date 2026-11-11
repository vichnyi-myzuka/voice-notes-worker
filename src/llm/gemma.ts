import type { Env } from "../env";
import type { JsonRequest } from "./types";
import { dataUrl } from "./utils";

export async function askGemma(env: Env, req: JsonRequest): Promise<string> {
	const res = (await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
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
	} as never)) as { choices?: { message?: { content?: unknown } }[]; response?: unknown };
	// Структуровану відповідь модель може віддати як рядок або вже як об'єкт.
	const content = res.choices?.[0]?.message?.content ?? res.response ?? "";
	return typeof content === "string" ? content : JSON.stringify(content);
}

import type { Env } from "../env";
import type { JsonRequest } from "./types";
import { dataUrl } from "./utils";

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
	const data = (await res.json()) as { output: { type: string; content?: { type: string; text?: string }[] }[] };
	return data.output
		.filter((o) => o.type === "message")
		.flatMap((o) => o.content ?? [])
		.filter((c) => c.type === "output_text")
		.map((c) => c.text ?? "")
		.join("");
}

import type { Env } from "../env";
import { askGemma } from "./gemma";
import { askLuna } from "./luna";
import type { JsonRequest } from "./types";

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

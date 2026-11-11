// Адаптер Llm: gpt-6-luna зі structured output, при збої Gemma 4 (Workers AI); Whisper для голосу.

import type { Llm } from "../../domain/llm";
import type { Env } from "../env";
import { askJson } from "./ask";
import { whisper } from "./transcribe";

export const workersLlm = (env: Env): Llm => ({
	askJson: (req, parse) => askJson(env, req, parse),
	transcribe: (audio, contentType) => whisper(env, audio, contentType),
});

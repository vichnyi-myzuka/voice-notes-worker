// Адаптер Llm: gpt-6-luna зі structured output, при збої Gemma 4 (Workers AI); Whisper для голосу.

import type { Llm } from "../../domain/llm";
import { askJson } from "./ask";
import type { LlmEnv } from "./env";
import { whisper } from "./transcribe";

export type { LlmEnv } from "./env";

export const workersLlm = (env: LlmEnv): Llm => ({
	askJson: (req, parse) => askJson(env, req, parse),
	transcribe: (audio, contentType) => whisper(env, audio, contentType),
});

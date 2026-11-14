import type { LlmEnv } from "./env";

// Whisper у Workers AI. Аудіо передаємо потоком (без base64).
// Автор завжди говорить українською, тож задаємо мову явно, щоб модель не сплутала її з російською.
// hint іде в initial_prompt: Whisper схильний писати слова зі словника саме так («Opus», а не «опис»).
export async function whisper(env: LlmEnv, audio: ArrayBuffer, contentType: string, hint?: string): Promise<string> {
	const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
		audio: { body: new Blob([audio]).stream(), contentType },
		language: "uk",
		...(hint && { initial_prompt: hint }),
	});
	return (res.text ?? "").trim();
}

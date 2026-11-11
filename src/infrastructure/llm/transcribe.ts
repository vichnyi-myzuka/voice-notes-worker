import type { Env } from "../env";

// Whisper у Workers AI. Аудіо передаємо потоком (без base64).
// Автор завжди говорить українською, тож задаємо мову явно, щоб модель не сплутала її з російською.
export async function whisper(env: Env, audio: ArrayBuffer, contentType: string): Promise<string> {
	const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
		audio: { body: new Blob([audio]).stream(), contentType },
		language: "uk",
	});
	return (res.text ?? "").trim();
}

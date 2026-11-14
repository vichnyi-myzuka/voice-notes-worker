import type { LlmEnv } from "./env";

// Whisper у Workers AI. Аудіо передаємо потоком (без base64).
// Автор завжди говорить українською, тож задаємо мову явно, щоб модель не сплутала її з російською.
// hint іде в initial_prompt: Whisper схильний писати слова зі словника саме так («Opus», а не «опис»).
export async function whisper(env: LlmEnv, audio: ArrayBuffer, contentType: string, hint?: string): Promise<string> {
	const started = Date.now();
	const input = `${contentType}, ${(audio.byteLength / 1000).toFixed(0)} КБ`;
	console.log(`whisper: start ${input}`);
	try {
		const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
			audio: { body: new Blob([audio]).stream(), contentType },
			language: "uk",
			...(hint && { initial_prompt: hint }),
		});
		const text = (res.text ?? "").trim();
		// Початок тексту допомагає помітити галюцинації Whisper на тиші; повний транскрипт у логи не пишемо.
		console.log(`whisper: ok ${input}, ${Date.now() - started}ms, ${text.length} символів${text ? `, початок: ${JSON.stringify(text.slice(0, 60))}` : " (порожньо)"}`);
		return text;
	} catch (err) {
		console.error(`whisper: failed ${input}, ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`, err);
		throw err;
	}
}

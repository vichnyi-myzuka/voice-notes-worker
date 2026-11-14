// Секрет сесії для виклику API воркера з контейнера (команда `schedule`, ADR 0005): HMAC-SHA256 від назви теки сесії на ключі воркера
// (пароль OpenCode, який воркер і так знає). Окремого сховища токенів немає: воркер перераховує його при кожному запиті.
export async function sessionToken(key: string, folder: string): Promise<string> {
	const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`session-api:${folder}`));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

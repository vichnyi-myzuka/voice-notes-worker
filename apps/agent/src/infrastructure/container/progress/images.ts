import { downloadTelegramFile, tg, type BotEnv } from "@voice-notes/core";
import type { ImageRef } from "../../../domain/agent";
import type { OutImage } from "../../../application/progress";
import type { PromptFile } from "../opencode";

// Зображення між Telegram і агентом.
// Вхід: фото від власника завантажується з Telegram і йде в OpenCode як вкладення (data:-посилання), тож модель бачить саме зображення.
// Вихід: агент вказує в підсумку `![підпис](/шлях/до/файлу.png)` (чи https-адресу), воркер забирає файл із контейнера й шле в чат фото.

function toBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

// Завантажує фото з Telegram (getFile ≤ 20 МБ) і готує вкладення для OpenCode.
export async function loadImages(env: BotEnv, refs: ImageRef[]): Promise<PromptFile[]> {
	const files: PromptFile[] = [];
	for (const [i, ref] of refs.entries()) {
		const { data } = await downloadTelegramFile(env, ref.fileId);
		const ext = ref.mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
		files.push({ uri: `data:${ref.mime};base64,${toBase64(data)}`, name: `telegram-${i + 1}.${ext}` });
	}
	return files;
}

// Шле зображення в чат (тема threadId, якщо є). Файл з контейнера читає read (undefined — недоступний): такий пропускається.
export async function sendImages(env: BotEnv, chat: number, images: OutImage[], read: (path: string) => Promise<Uint8Array | undefined>, threadId?: number): Promise<void> {
	for (const image of images) {
		try {
			const caption = image.caption.slice(0, 1024);
			if (/^https:/i.test(image.source)) {
				await tg(env, "sendPhoto", { chat_id: chat, photo: image.source, caption, ...(threadId && { message_thread_id: threadId }) });
				continue;
			}
			const bytes = await read(image.source);
			if (!bytes) {
				console.error(`image skipped (not readable): ${image.source}`);
				continue;
			}
			const form = new FormData();
			form.set("chat_id", String(chat));
			if (threadId) form.set("message_thread_id", String(threadId));
			if (caption) form.set("caption", caption);
			form.set("photo", new Blob([bytes]), image.source.split("/").pop() ?? "image.png");
			await tg(env, "sendPhoto", form);
		} catch (err) {
			console.error("send image failed:", err);
		}
	}
}

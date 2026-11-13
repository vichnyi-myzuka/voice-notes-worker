import { tg, type BotEnv } from "@voice-notes/core";
import type { ImageRef } from "../../domain/agent";
import type { PromptFile } from "./opencode";

// Зображення між Telegram і агентом.
// Вхід: фото від власника завантажується з Telegram і йде в OpenCode як вкладення (data:-посилання), тож модель бачить саме зображення.
// Вихід: агент вказує в підсумку `![підпис](/шлях/до/файлу.png)` (чи https-адресу), воркер забирає файл із контейнера й шле в чат фото.

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // ліміт sendPhoto
export const IMAGES_MAX = 5; // не більше стількох зображень за підсумок

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
		const info = await tg(env, "getFile", { file_id: ref.fileId });
		const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
		if (!res.ok) throw new Error(`image download ${res.status}`);
		const ext = ref.mime.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
		files.push({ uri: `data:${ref.mime};base64,${toBase64(await res.arrayBuffer())}`, name: `telegram-${i + 1}.${ext}` });
	}
	return files;
}

export type OutImage = { source: string; caption: string };

// Зображення в тексті підсумку (`![підпис](джерело)`): повертає текст без них і список. Джерело — абсолютний шлях до png/jpg/gif/webp
// чи https-адреса; решта лишається в тексті як є.
const IMAGE_MARKDOWN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const IMAGE_PATH = /^\/.*\.(?:png|jpe?g|gif|webp)$/i;
export function extractImages(text: string): { text: string; images: OutImage[] } {
	const images: OutImage[] = [];
	const rest = text.replace(IMAGE_MARKDOWN, (whole, caption: string, source: string) => {
		if (!IMAGE_PATH.test(source) && !/^https:\/\//i.test(source)) return whole;
		if (images.length < IMAGES_MAX) images.push({ source, caption: caption.trim() });
		return "";
	});
	return { text: images.length ? rest.replace(/\n{3,}/g, "\n\n").trim() : text, images };
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

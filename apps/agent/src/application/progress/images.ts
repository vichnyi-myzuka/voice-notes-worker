// Зображення в підсумку агента: ліміти й розбір `![підпис](/шлях/до/файлу.png)` (чи https-адреса). Завантаження й надсилання — в infrastructure.

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // ліміт sendPhoto
export const IMAGES_MAX = 5; // не більше стількох зображень за підсумок

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

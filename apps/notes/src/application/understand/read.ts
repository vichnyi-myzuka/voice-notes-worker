import { parseJsonObject } from "../../domain/json";
import type { Llm } from "../../domain/llm";

export const IMAGE_SYSTEM = `The author sent a photo as a note, optionally with a caption. Read the image.
- text: all text visible on the image, verbatim, in its original language, keeping line breaks; "" if there is none.
- description: 1–2 sentences in Ukrainian on what the image shows (e.g. receipt, screenshot of a chat, handwritten list, poster, whiteboard), without repeating the text.`;

export async function readImage(llm: Llm, image: ArrayBuffer, type: string, caption: string, lastAttempt: boolean): Promise<string> {
	const schema = {
		type: "object",
		properties: { text: { type: "string" }, description: { type: "string" } },
		required: ["text", "description"],
		additionalProperties: false,
	};
	const res = await llm.askJson(
		{ name: "image_note", system: IMAGE_SYSTEM, user: caption ? `Caption: ${caption}` : "No caption.", schema, image: { data: image, type } },
		(t) => {
			const j = parseJsonObject(t);
			return { text: String(j.text ?? "").trim(), description: String(j.description ?? "").trim() };
		},
	);
	if (!res && !lastAttempt) throw new Error("All image models failed");
	return [
		caption && `Підпис автора: ${caption}`,
		res?.description && `Що на фото: ${res.description}`,
		res?.text && `Текст на фото:\n${res.text}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

import type { JsonRequest } from "./types";

// ArrayBuffer → base64 частинами (String.fromCharCode з великим масивом переповнює стек).
export function toBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export const dataUrl = (image: NonNullable<JsonRequest["image"]>) => `data:${image.type};base64,${image.base64}`;

// Витягує перший JSON-об'єкт з відповіді моделі.
export function parseJsonObject(text: string): Record<string, unknown> {
	return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

import type { TriageItem } from "../todoist";

// discard: "delete" — лише в режимі редагування («видали нотатку»).
export type Meta = { title: string; summary: string; ideas: string[]; tasks: string[]; discard?: "empty" | "cancelled" | "delete" };

// Слайс стану обробки: що зрозуміли із запису (див. state.ts).
export type ContentState = {
	transcript?: string;
	meta?: Meta;
	triage?: TriageItem[] | null; // null: тріаж не вдався або не потрібен
};

// Назва теми чату за змістом розмови: після кожного ходу агента маленька модель (через порт Llm) бачить поточну назву, завдання,
// останнє уточнення власника й підсумок ходу та лишає назву, якщо напрям не змінився, або дає нову. Збій чи тайм-аут дають undefined
// (назва лишається).

import type { Llm } from "@voice-notes/core";
import { redact } from "./narrate";

export const TITLE_MAX = 60;
const TEXT_MAX = 600;
export const TITLE_TIMEOUT_MS = 6000;

const SYSTEM = `You name a chat thread of a coding agent that works for its owner. You get the current title, the original task, the owner's latest follow-up (may be absent) and the agent's latest result. Reply with "title": a short semantic title in Ukrainian, 3-7 words, up to ${TITLE_MAX} characters, that says what this conversation is about now (the subject and the kind of work, e.g. "Семантичні назви тем у Telegram" or "Виправлення помилки в підписах нотаток"). Keep the current title word for word if it still describes the conversation well: change it only when the direction of the work has clearly moved to another subject. No quotes, no trailing period, no emoji, no prefixes like "feat:".`;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Приводить відповідь моделі до назви теми; порожнє чи не рядок → undefined.
export function cleanTitle(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const title = raw.replace(/[]/g, "").replace(/\s+/g, " ").replace(/^[\s"«']+|[\s"»'.]+$/g, "");
	return title ? cut(title, TITLE_MAX) : undefined;
}

export async function retitle(llm: Llm, current: string, task: string, followUp: string | undefined, result: string): Promise<string | undefined> {
	const user = `<current_title>${current}</current_title>\n<task>\n${cut(redact(task), TEXT_MAX)}\n</task>${followUp ? `\n<follow_up>\n${cut(redact(followUp), TEXT_MAX)}\n</follow_up>` : ""}\n<result>\n${cut(redact(result), TEXT_MAX)}\n</result>`;
	const ask = llm.askJson(
		{
			name: "agent_thread_title",
			system: SYSTEM,
			user,
			schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
			reasoning: "none",
		},
		(text) => (JSON.parse(text) as { title?: unknown }).title,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => void (timer = setTimeout(() => resolve(null), TITLE_TIMEOUT_MS)));
	const title = await Promise.race([ask, timeout]).catch(() => null);
	clearTimeout(timer);
	return cleanTitle(title);
}

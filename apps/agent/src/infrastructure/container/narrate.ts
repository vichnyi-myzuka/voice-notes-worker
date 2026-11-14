// Підпис поточної дії «людською мовою»: маленька модель (через порт Llm) дивиться на завдання й кілька останніх дій агента
// і каже, що відбувається («перевіряє, як формується підпис у чаті»), замість «виконує grep». Збій чи тайм-аут дають undefined,
// тоді пост показує технічний підпис з describeActivity.

import type { Llm } from "@voice-notes/core";
import { argSummary } from "./activity";

const RECENT_MAX = 8; // скільки останніх дій бачить модель
const CALL_MAX = 160; // довжина опису однієї дії
const TASK_MAX = 600;
const STATUS_MAX = 80;
export const NARRATE_TIMEOUT_MS = 4000; // пост не має чекати модель довго: далі технічний підпис

// У контекст для моделі (стороннього сервісу) не мають потрапити токени: значення біля слів token/key/secret/password/bearer
// і довгі «схожі на ключ» рядки замінюються на ***.
export function redact(s: string): string {
	return s
		.replace(/\b(bearer|basic)\s+\S+/gi, "$1 ***")
		.replace(/\b(token|secret|password|passwd|api[_-]?key|key)(\s*[:=]\s*|\s+)\S+/gi, "$1$2***")
		.replace(/\b(?:gh[pousr]_|sk-|xox[a-z]-)[\w-]{8,}/g, "***")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (p: string) => p.replace(/^\/workspace\/(?:sessions\/[^/]+\/|repos\/[^/]+\/[^/]+\/)?/, "");

// Докладний опис виклику для моделі: на відміну від підпису в пості, містить команду, шаблон пошуку, опис підзадачі.
export function describeCall(tool: string, input: Record<string, unknown> | undefined): string {
	const i = input ?? {};
	const file = str(i.filePath) ?? str(i.path) ?? str(i.file);
	const detail =
		str(i.description) ?? // у bash і task OpenCode кладе туди опис дії словами агента
		(str(i.command) && redact(str(i.command)!.split("\n")[0])) ??
		str(i.pattern) ??
		str(i.url) ??
		str(i.query) ??
		(file && short(file)) ??
		(redact(argSummary(i, 5)) || undefined); // інструменти MCP (напр. sure_get_transactions, silpo_…): без відомих полів показуємо скалярні аргументи
	return cut(detail ? `${tool}: ${detail}` : tool, CALL_MAX);
}

// Остання дія додається в кінець; зберігаються лише RECENT_MAX останніх.
export const remember = (recent: string[], call: string): string[] => [...recent, call].slice(-RECENT_MAX);

const SYSTEM = `You write a one-line live status for a coding agent that works for its owner. You get the task and the agent's latest actions (tool calls, oldest first). Reply with "status": what the agent is doing right now and why, in Ukrainian, in the present tense, 3-9 words, e.g. "перевіряє, як формується підпис у чаті" or "запускає тести після змін". Describe the purpose, not the mechanics: never mention tool names, shell commands, flags or raw paths (a file name is fine when it helps). For calls to the owner's finance app (tools starting with "sure_") say concretely what is being looked up or changed, using the call's arguments (period, category, account), e.g. "дивиться витрати на їжу за жовтень" or "порівнює бюджет із фактичними витратами"; never state amounts or balances. Calls to the owner's Silpo supermarket account (tools starting with "silpo_") are about their purchase history: say what is looked up (period, product), e.g. "дивиться чеки Сільпо за жовтень"; never state amounts. Calls to the owner's Google Calendar (tools starting with "calendar_") are about their schedule: say what is looked up or changed (day, kind of event), e.g. "дивиться розклад на завтра" or "переносить зустріч"; never state event titles or attendees. Calls to the owner's Cloudflare account (tools starting with "cloudflare_") manage their Cloudflare resources (Workers, DNS, R2, KV…): say what is looked up or changed, e.g. "дивиться список воркерів" or "оновлює DNS-запис"; never state tokens, secrets or account ids. No quotes, no trailing period, no emoji. Do not repeat the previous status word for word unless nothing has changed.`;

export async function narrate(llm: Llm, task: string, recent: string[], previous?: string): Promise<string | undefined> {
	if (recent.length === 0) return undefined;
	const user = `<task>\n${cut(redact(task), TASK_MAX)}\n</task>\n<latest_actions>\n${recent.map((c) => `- ${c}`).join("\n")}\n</latest_actions>${previous ? `\n<previous_status>${previous}</previous_status>` : ""}`;
	const ask = llm.askJson(
		{
			name: "agent_status",
			system: SYSTEM,
			user,
			schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false },
			reasoning: "none",
		},
		(text) => (JSON.parse(text) as { status?: unknown }).status,
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => void (timer = setTimeout(() => resolve(null), NARRATE_TIMEOUT_MS)));
	const status = await Promise.race([ask, timeout]).catch(() => null);
	clearTimeout(timer);
	const clean = typeof status === "string" ? status.replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim() : "";
	return clean ? cut(clean, STATUS_MAX) : undefined;
}

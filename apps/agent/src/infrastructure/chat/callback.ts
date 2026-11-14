// callback_data кнопок під постами: формат живе тільки тут. Формують його chat (клавіатура) і interface/github (запит на деплой),
// розбирає interface/telegram. Telegram дозволяє до 64 байт.

import type { McpName } from "../../domain/agent";

export type SessionAction = "stop" | "del" | "merge" | "ok";

export const callback = {
	stop: (id: string) => `stop:${id}`,
	merge: (id: string) => `merge:${id}`,
	del: (id: string) => `del:${id}`,
	dismiss: "dismiss",
	confirm: (id: string) => `ok:${id}`,
	answer: (id: string, choice: number) => `ans:${id}:${choice}`,
	toggle: (id: string, choice: number) => `tog:${id}:${choice}`,
	approve: (repo: string, runId: number) => `appr:${repo}:${runId}`,
	reject: (repo: string, runId: number) => `rej:${repo}:${runId}`,
	// Вибір репозиторію для ще не створеної сесії: номер у списку чи "-" (без репозиторію).
	pick: (id: string, choice: number | "none") => `pick:${id}:${choice === "none" ? "-" : choice}`,
	// Підключити MCP до ще не створеної сесії (одна відповідь на всі запитані сервіси) чи посеред живої (один сервіс).
	mcpStart: (id: string, allow: boolean) => `mcps:${id}:${allow ? "y" : "n"}`,
	mcpLive: (id: string, name: McpName, allow: boolean) => `mcpl:${id}:${name}:${allow ? "y" : "n"}`,
};

export type Callback =
	| { kind: "dismiss" }
	| { kind: "review"; approve: boolean; repo: string; runId: number }
	| { kind: "session"; action: SessionAction; id: string }
	| { kind: "pick"; id: string; choice: number | "none" }
	| { kind: "choice"; toggle: boolean; id: string; choice: number }
	| { kind: "mcp-start"; id: string; allow: boolean }
	| { kind: "mcp-live"; id: string; name: McpName; allow: boolean };

const REVIEW = /^(appr|rej):([\w.-]+\/[\w.-]+):(\d+)$/;
const SESSION = /^(stop|del|merge|ok):(tg-[\w-]+)$/;
const PICK = /^pick:(tg-[\w-]+):(\d+|-)$/;
const MCP_START = /^mcps:(tg-[\w-]+):([yn])$/;
const MCP_LIVE = /^mcpl:(tg-[\w-]+):(sure|silpo|calendar|cloudflare):([yn])$/;
const CHOICE = /^(ans|tog):(tg-[\w-]+):(\d+)$/;

// undefined — не наша кнопка або формат невідомий.
export function parseCallback(data: string | undefined): Callback | undefined {
	if (data === callback.dismiss) return { kind: "dismiss" };
	const review = REVIEW.exec(data ?? "");
	if (review) return { kind: "review", approve: review[1] === "appr", repo: review[2], runId: Number(review[3]) };
	const session = SESSION.exec(data ?? "");
	if (session) return { kind: "session", action: session[1] as SessionAction, id: session[2] };
	const pick = PICK.exec(data ?? "");
	if (pick) return { kind: "pick", id: pick[1], choice: pick[2] === "-" ? "none" : Number(pick[2]) };
	const choice = CHOICE.exec(data ?? "");
	if (choice) return { kind: "choice", toggle: choice[1] === "tog", id: choice[2], choice: Number(choice[3]) };
	const mcpStart = MCP_START.exec(data ?? "");
	if (mcpStart) return { kind: "mcp-start", id: mcpStart[1], allow: mcpStart[2] === "y" };
	const mcpLive = MCP_LIVE.exec(data ?? "");
	if (mcpLive) return { kind: "mcp-live", id: mcpLive[1], name: mcpLive[2] as McpName, allow: mcpLive[3] === "y" };
	return undefined;
}

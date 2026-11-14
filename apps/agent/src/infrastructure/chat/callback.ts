// callback_data кнопок під постами: формат живе тільки тут. Формують його chat (клавіатура) і interface/github (запит на деплой),
// розбирає interface/telegram. Telegram дозволяє до 64 байт.

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
	// Підтвердження розкладу від агента (ADR 0005): ok — активувати, no — відхилити.
	schedule: (action: "ok" | "no", id: string) => `sch:${action}:${id}`,
	// Вибір репозиторію для ще не створеної сесії: номер у списку чи "-" (без репозиторію).
	pick: (id: string, choice: number | "none") => `pick:${id}:${choice === "none" ? "-" : choice}`,
};

export type Callback =
	| { kind: "dismiss" }
	| { kind: "review"; approve: boolean; repo: string; runId: number }
	| { kind: "session"; action: SessionAction; id: string }
	| { kind: "schedule"; approve: boolean; id: string }
	| { kind: "pick"; id: string; choice: number | "none" }
	| { kind: "choice"; toggle: boolean; id: string; choice: number };

const REVIEW = /^(appr|rej):([\w.-]+\/[\w.-]+):(\d+)$/;
const SESSION = /^(stop|del|merge|ok):(tg-[\w-]+)$/;
const SCHEDULE = /^sch:(ok|no):([a-f0-9]{8})$/;
const PICK = /^pick:(tg-[\w-]+):(\d+|-)$/;
const CHOICE = /^(ans|tog):(tg-[\w-]+):(\d+)$/;

// undefined — не наша кнопка або формат невідомий.
export function parseCallback(data: string | undefined): Callback | undefined {
	if (data === callback.dismiss) return { kind: "dismiss" };
	const review = REVIEW.exec(data ?? "");
	if (review) return { kind: "review", approve: review[1] === "appr", repo: review[2], runId: Number(review[3]) };
	const session = SESSION.exec(data ?? "");
	if (session) return { kind: "session", action: session[1] as SessionAction, id: session[2] };
	const schedule = SCHEDULE.exec(data ?? "");
	if (schedule) return { kind: "schedule", approve: schedule[1] === "ok", id: schedule[2] };
	const pick = PICK.exec(data ?? "");
	if (pick) return { kind: "pick", id: pick[1], choice: pick[2] === "-" ? "none" : Number(pick[2]) };
	const choice = CHOICE.exec(data ?? "");
	if (choice) return { kind: "choice", toggle: choice[1] === "tog", id: choice[2], choice: Number(choice[3]) };
	return undefined;
}

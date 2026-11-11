// Мінімальний клієнт HTTP API OpenCode V2 (`opencode serve`, маршрути `/api/...`) усередині контейнера.

export const OPENCODE_PORT = 4096;

export type Opencode = { fetch: (path: string, init?: RequestInit) => Promise<Response> };

// V2: basic auth, ім'я користувача завжди `opencode`, пароль — OPENCODE_PASSWORD.
export const basicAuth = (password: string) => `Basic ${btoa(`opencode:${password}`)}`;

async function data<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error(`opencode ${res.url}: ${res.status} ${await res.text()}`);
	return (await res.json<{ data: T }>()).data;
}

const post = (body?: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// Сервер готовий, коли відповідає /api/info.
export async function isReady(oc: Opencode): Promise<boolean> {
	const res = await oc.fetch("/api/info", { signal: AbortSignal.timeout(1500) });
	await res.body?.cancel();
	return res.ok;
}

export type ModelRef = { providerID: string; id: string };

export async function createSession(oc: Opencode, title: string, directory: string, model?: ModelRef): Promise<string> {
	return (await data<{ id: string }>(await oc.fetch("/api/session", post({ title, location: { directory }, ...(model && { model }) })))).id;
}

// Чи є модель у списку доступних. Моделі провайдера з'являються з затримкою після підключення.
export async function hasModel(oc: Opencode, model: ModelRef): Promise<boolean> {
	const models = await data<{ id: string; providerID: string }[]>(await oc.fetch("/api/model"));
	return models.some((m) => m.providerID === model.providerID && m.id === model.id);
}

// Провайдер «Claude Agent»: OpenCode запускає встановлений у контейнері `claude`, який бере токен підписки
// зі змінної CLAUDE_CODE_OAUTH_TOKEN. Підключення лише фіксує вибір методу (відповідь 204).
export async function connectClaudeAgent(oc: Opencode): Promise<void> {
	const res = await oc.fetch("/api/integration/claude-agent/connect/external", post({ methodID: "claude-login" }));
	if (!res.ok) throw new Error(`opencode connect claude-agent: ${res.status} ${await res.text()}`);
	await res.body?.cancel();
}

// Повертається, щойно запит прийнято в чергу сесії; агент працює у фоні.
export async function prompt(oc: Opencode, sessionId: string, text: string): Promise<void> {
	await data(await oc.fetch(`/api/session/${sessionId}/prompt`, post({ text })));
}

export async function sessionExists(oc: Opencode, sessionId: string): Promise<boolean> {
	const res = await oc.fetch(`/api/session/${sessionId}`);
	await res.body?.cancel();
	return res.ok;
}

// Активні (виконуються зараз) сесії: є запис — працює, немає — вільна.
export async function isBusy(oc: Opencode, sessionId: string): Promise<boolean> {
	return sessionId in (await data<Record<string, { type: string }>>(await oc.fetch("/api/session/active")));
}

// Чи працює зараз хоч одна сесія (сервер спільний для всіх сесій і тек).
export async function isAnyBusy(oc: Opencode): Promise<boolean> {
	return Object.keys(await data<Record<string, unknown>>(await oc.fetch("/api/session/active"))).length > 0;
}

export async function deleteSession(oc: Opencode, sessionId: string): Promise<void> {
	const res = await oc.fetch(`/api/session/${sessionId}`, { method: "DELETE" });
	const status = res.status;
	await res.body?.cancel();
	if (!res.ok && status !== 404) throw new Error(`opencode delete session: ${status}`);
}

export async function interrupt(oc: Opencode, sessionId: string): Promise<void> {
	const res = await oc.fetch(`/api/session/${sessionId}/interrupt`, post());
	if (!res.ok) throw new Error(`opencode interrupt: ${res.status} ${await res.text()}`);
	await res.body?.cancel();
}

// Сесія з лічильниками: вартість, токени й чим закінчилась остання робота (outcome з'являється після першої).
export type SessionInfo = {
	cost?: number;
	tokens?: { input?: number; output?: number; reasoning?: number };
	outcome?: "succeeded" | "failed" | "interrupted";
	time?: { idle?: number };
};

export async function getSession(oc: Opencode, sessionId: string): Promise<SessionInfo> {
	return data<SessionInfo>(await oc.fetch(`/api/session/${sessionId}`));
}

// Токени без кешу: за ними видно, скільки сесія реально «прочитала й написала».
export const totalTokens = (s: SessionInfo): number => (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0) + (s.tokens?.reasoning ?? 0);

// Ідентифікатори сесій, що виконуються зараз.
export async function activeSessions(oc: Opencode): Promise<string[]> {
	return Object.keys(await data<Record<string, unknown>>(await oc.fetch("/api/session/active")));
}

// Останнє повідомлення асистента: його текст (підсумок) і помилка, якщо робота впала.
export async function lastAssistant(oc: Opencode, sessionId: string): Promise<{ text: string; error?: string }> {
	const res = await oc.fetch(`/api/session/${sessionId}/message?type=assistant&order=desc&limit=1`);
	if (!res.ok) return { text: "" };
	const [msg] = (await res.json<{ data: { content?: { type: string; text?: string }[]; error?: { message?: string } }[] }>()).data;
	const text = (msg?.content ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).at(-1) ?? "";
	return { text: text.trim(), error: msg?.error?.message };
}

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

export async function interrupt(oc: Opencode, sessionId: string): Promise<void> {
	const res = await oc.fetch(`/api/session/${sessionId}/interrupt`, post());
	if (!res.ok) throw new Error(`opencode interrupt: ${res.status} ${await res.text()}`);
	await res.body?.cancel();
}

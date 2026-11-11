// Мінімальний клієнт HTTP API OpenCode (`opencode serve` / `opencode web`) усередині контейнера.

export const OPENCODE_PORT = 4096;

export type Opencode = { fetch: (path: string, init?: RequestInit) => Promise<Response> };

export const basicAuth = (password: string) => `Basic ${btoa(`opencode:${password}`)}`;

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error(`opencode ${res.url}: ${res.status} ${await res.text()}`);
	return res.json<T>();
}

export async function createSession(oc: Opencode, title: string): Promise<string> {
	const res = await oc.fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
	return (await json<{ id: string }>(res)).id;
}

// Асинхронний запуск: відповідь одразу, агент працює у фоні.
export async function promptAsync(oc: Opencode, sessionId: string, text: string): Promise<void> {
	const res = await oc.fetch(`/session/${sessionId}/prompt_async`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ parts: [{ type: "text", text }] }),
	});
	if (!res.ok) throw new Error(`opencode prompt_async: ${res.status} ${await res.text()}`);
}

export async function sessionExists(oc: Opencode, sessionId: string): Promise<boolean> {
	const res = await oc.fetch(`/session/${sessionId}`);
	await res.body?.cancel();
	return res.ok;
}

// busy/retry → працює; у відповіді немає запису або idle → вільна.
export async function isBusy(oc: Opencode, sessionId: string): Promise<boolean> {
	const statuses = await json<Record<string, { type: string }>>(await oc.fetch("/session/status"));
	const type = statuses[sessionId]?.type;
	return type === "busy" || type === "retry";
}

export async function abortSession(oc: Opencode, sessionId: string): Promise<void> {
	const res = await oc.fetch(`/session/${sessionId}/abort`, { method: "POST" });
	if (!res.ok) throw new Error(`opencode abort: ${res.status} ${await res.text()}`);
}

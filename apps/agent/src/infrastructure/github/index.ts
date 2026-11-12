// Мінімальний клієнт GitHub REST: лише те, що потрібно воркеру агента (видалити гілку, схвалити деплой).
const API = "https://api.github.com";

async function gh(token: string, method: string, path: string, body?: unknown): Promise<Response> {
	return fetch(`${API}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agent-worker", ...(body ? { "content-type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}

// Видаляє гілку в GitHub. Уже видалену (404/422, наприклад автовидалення в налаштуваннях репозиторію) не вважаємо збоєм.
export async function deleteBranch(token: string, repo: string, branch: string): Promise<void> {
	const res = await gh(token, "DELETE", `/repos/${repo}/git/refs/heads/${branch}`);
	if (!res.ok && res.status !== 404 && res.status !== 422) throw new Error(`delete branch ${res.status}`);
}

// Схвалює чи відхиляє деплої запуску, що чекають рев'ю (environment із Required reviewers). Повертає кількість оброблених;
// 0 — нічого не чекало (уже схвалено десь інде) або токен не має права рев'ю.
export async function reviewDeployments(token: string, repo: string, runId: number, approve: boolean): Promise<number> {
	const path = `/repos/${repo}/actions/runs/${runId}/pending_deployments`;
	const list = await gh(token, "GET", path);
	if (!list.ok) throw new Error(`pending deployments ${list.status}`);
	const pending = await list.json<{ environment: { id: number }; current_user_can_approve: boolean }[]>();
	const ids = pending.filter((p) => p.current_user_can_approve).map((p) => p.environment.id);
	if (!ids.length) return 0;
	const res = await gh(token, "POST", path, { environment_ids: ids, state: approve ? "approved" : "rejected", comment: "Telegram" });
	if (!res.ok) throw new Error(`review deployments ${res.status}`);
	return ids.length;
}

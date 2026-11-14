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

// Номер відкритого PR з гілки цього ж репозиторію (не форка); undefined, якщо PR немає.
export async function openPullNumber(token: string, repo: string, branch: string): Promise<number | undefined> {
	const owner = repo.split("/")[0];
	const res = await gh(token, "GET", `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
	if (!res.ok) throw new Error(`open pulls ${res.status}`);
	return (await res.json<{ number: number }[]>())[0]?.number;
}

// Мерджить PR (звичайний merge-коміт, як і решта PR репозиторію). GitHub відмовляє, якщо перевірки не пройшли чи є конфлікт:
// тоді кидаємо його пояснення.
export class MergeRefused extends Error {}

export async function mergePull(token: string, repo: string, number: number): Promise<void> {
	const res = await gh(token, "PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: "merge" });
	if (res.ok) return;
	const detail = await res.json<{ message?: string }>().then((b) => b.message, () => undefined);
	const message = detail ?? `merge ${res.status}`;
	// 405 (не можна змерджити) і 409 (гілка змінилась) — відмова за станом PR, а не збій запиту: для неї шукаємо причини
	throw res.status === 405 || res.status === 409 ? new MergeRefused(message) : new Error(message);
}

// Людські причини, чому PR не мерджиться: конфлікти, перевірки (CI), чернетка, відставання від бази, правила гілки.
// Порожньо, якщо причин не знайдено (тоді лишається пояснення самого GitHub).
export async function mergeBlockers(token: string, repo: string, number: number): Promise<string[]> {
	const res = await gh(token, "GET", `/repos/${repo}/pulls/${number}`);
	if (!res.ok) throw new Error(`pull ${res.status}`);
	const pr = await res.json<{ draft?: boolean; mergeable: boolean | null; mergeable_state?: string; head: { sha: string } }>();
	const reasons: string[] = [];
	if (pr.draft) reasons.push("PR у чернетці (draft)");
	if (pr.mergeable === false || pr.mergeable_state === "dirty") reasons.push("Є конфлікти з основною гілкою");
	if (pr.mergeable_state === "behind") reasons.push("Гілка відстає від основної: потрібно її оновити");
	const checks = await gh(token, "GET", `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
	if (checks.ok) {
		const runs = (await checks.json<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>()).check_runs;
		const failed = runs.filter((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? ""));
		const pending = runs.filter((c) => c.status !== "completed");
		if (failed.length) reasons.push(`CI не пройшов: ${failed.map((c) => c.name).join(", ")}`);
		if (pending.length) reasons.push(`CI ще виконується: ${pending.map((c) => c.name).join(", ")}`);
	}
	// Нічого конкретного не знайшли, а GitHub каже «blocked»: лишилися правила гілки (схвалення рев'ю тощо)
	if (!reasons.length && pr.mergeable_state === "blocked") reasons.push("Мерж заблоковано правилами гілки (напр., потрібне схвалення рев'ю або обов'язкові перевірки)");
	return reasons;
}

// PR, змерджені в цей коміт (за ними показуємо результат деплою й прибираємо сесії); порожньо, якщо коміт пушили без PR.
export type CommitPull = { number: number; title: string; url: string; branch: string; repo?: string };
export async function commitPulls(token: string, repo: string, sha: string): Promise<CommitPull[]> {
	const res = await gh(token, "GET", `/repos/${repo}/commits/${sha}/pulls`);
	if (!res.ok) throw new Error(`commit pulls ${res.status}`);
	const pulls = await res.json<{ number: number; title: string; html_url: string; head: { ref: string; repo?: { full_name: string } | null } }[]>();
	return pulls.map((p) => ({ number: p.number, title: p.title, url: p.html_url, branch: p.head.ref, repo: p.head.repo?.full_name }));
}

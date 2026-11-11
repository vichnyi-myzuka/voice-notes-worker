import type { IssueRepo, IssueTracker } from "../../domain/issues";
import type { Env } from "../env";

const API = "https://api.github.com";

// ISSUE_REPOS — JSON: [{"repo":"власник/назва","description":"про що проєкт"}]. Помилка в налаштуванні вимикає issues, а не нотатки.
export function parseRepos(raw: string | undefined): IssueRepo[] {
	try {
		const list: unknown = JSON.parse(raw || "[]");
		if (!Array.isArray(list)) return [];
		return list.filter(
			(r): r is IssueRepo => typeof r?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(r.repo) && typeof r.description === "string",
		);
	} catch {
		return [];
	}
}

// Адаптер IssueTracker для GitHub (REST). Токен — fine-grained, лише Issues: write на потрібні репозиторії.
export function githubIssues(env: Env): IssueTracker {
	const repos = parseRepos(env.ISSUE_REPOS);
	const call = async (method: string, path: string, body: object) => {
		const res = await fetch(`${API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
				"user-agent": "voice-notes-worker",
				"x-github-api-version": "2022-11-28",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
		return (await res.json()) as { number: number; html_url: string };
	};
	return {
		enabled: Boolean(env.GITHUB_ISSUES_TOKEN) && repos.length > 0,
		repos,
		async create(repo, issue) {
			const created = await call("POST", `/repos/${repo}/issues`, issue);
			return { number: created.number, url: created.html_url };
		},
		async update(repo, number, issue) {
			await call("PATCH", `/repos/${repo}/issues/${number}`, issue);
		},
		async close(repo, number, comment) {
			await call("POST", `/repos/${repo}/issues/${number}/comments`, { body: comment });
			await call("PATCH", `/repos/${repo}/issues/${number}`, { state: "closed", state_reason: "not_planned" });
		},
	};
}

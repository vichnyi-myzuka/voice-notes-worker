// Відомі репозиторії: `repo` (owner/name) і `about` — як власник про нього говорить (для вибору з вільної мови).
// `site` (необов'язково) — назва публічного сайту, який агент оновлює після мержу PR (репозиторії-сайти, напр. гра).
export type KnownRepo = { repo: string; about: string; site?: string };

const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const SITE = /^[a-z0-9][a-z0-9-]{1,39}$/;

// AGENT_REPOS: JSON-масив [{repo, about, site?}]. Некоректні елементи й сам JSON тихо ігноруються: вибір репозиторію вимикається.
export function parseRepos(raw: string | undefined): KnownRepo[] {
	try {
		const list: unknown = JSON.parse(raw ?? "[]");
		if (!Array.isArray(list)) return [];
		return list
			.filter((r): r is KnownRepo => typeof r?.repo === "string" && REPO.test(r.repo) && typeof r.about === "string")
			.map((r) => ({ repo: r.repo, about: r.about, ...(typeof r.site === "string" && SITE.test(r.site) && { site: r.site }) }));
	} catch {
		return [];
	}
}

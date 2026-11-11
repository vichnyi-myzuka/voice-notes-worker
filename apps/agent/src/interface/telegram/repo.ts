import type { Llm } from "@voice-notes/core";

// Відомі репозиторії: `repo` (owner/name) і `about` — як власник про нього говорить (для вибору з вільної мови).
export type KnownRepo = { repo: string; about: string };

const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

// AGENT_REPOS: JSON-масив [{repo, about}]. Некоректні елементи й сам JSON тихо ігноруються: вибір репозиторію вимикається.
export function parseRepos(raw: string | undefined): KnownRepo[] {
	try {
		const list: unknown = JSON.parse(raw ?? "[]");
		if (!Array.isArray(list)) return [];
		return list.filter((r): r is KnownRepo => typeof r?.repo === "string" && REPO.test(r.repo) && typeof r.about === "string");
	} catch {
		return [];
	}
}

const SYSTEM = `You route tasks for a coding agent. The owner dictates a task (usually in Ukrainian). Decide whether the task is about working inside one of the known repositories.
Pick a repository only when the owner clearly refers to it: by name, by a description from the list ("our bot", "this project", "yourself"), or because the task obviously changes that code. When the task is generic, about something new, or you are not sure, answer "none".`;

// Репозиторій з вільної фрази («давай попрацюємо над нашим ботом»). undefined — нічого не вибрано (або модель не відповіла).
export async function pickRepo(llm: Llm, repos: KnownRepo[], task: string): Promise<string | undefined> {
	if (repos.length === 0) return undefined;
	const names = repos.map((r) => r.repo);
	const list = repos.map((r) => `- ${r.repo}: ${r.about}`).join("\n");
	const picked = await llm.askJson(
		{
			name: "agent_repo",
			system: SYSTEM,
			user: `Known repositories:\n${list}\n\n<task>\n${task}\n</task>`,
			schema: { type: "object", properties: { repo: { type: "string", enum: [...names, "none"] } }, required: ["repo"], additionalProperties: false },
			reasoning: "none",
		},
		(text) => (JSON.parse(text) as { repo?: string }).repo,
	);
	return picked && names.includes(picked) ? picked : undefined;
}

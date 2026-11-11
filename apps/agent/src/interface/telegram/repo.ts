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

const SYSTEM = `You route tasks for a coding agent. The owner dictates a task (usually in Ukrainian). Answer with:
- "type": the kind of work, like a conventional-commit type: feat (new capability), fix (bug), docs, refactor, test, chore (tooling, config, maintenance).
- "name": a short English kebab-case name for the task without the type, 2-4 words, only a-z, 0-9 and "-", e.g. "session-delete" or "readme-typos". Together with the type it becomes the folder and git branch name ("feat-session-delete"), so describe the work, not the wording of the request.
- "repo" (only if asked): decide whether the task is about working inside one of the known repositories. Pick one only when the owner clearly refers to it: by name, by a description from the list ("our bot", "this project", "yourself"), or because the task obviously changes that code. When the task is generic, about something new, or you are not sure, answer "none".`;

export type Route = { repo?: string; name?: string };

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const TYPES = ["feat", "fix", "docs", "refactor", "test", "chore"] as const;

// Назва з відповіді моделі приводиться до безпечного вигляду; непридатна (порожня, закоротка) відкидається.
export function cleanName(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
	return NAME.test(name) ? name : undefined;
}

// Один виклик моделі: назва для теки/гілки за змістом задачі й (якщо є відомі репозиторії) репозиторій із вільної фрази
// («давай попрацюємо над нашим ботом»). Збій моделі дає порожній результат: сесія просто отримає технічну назву.
export async function routeTask(llm: Llm, repos: KnownRepo[], task: string): Promise<Route> {
	const names = repos.map((r) => r.repo);
	const list = repos.length ? `Known repositories:\n${repos.map((r) => `- ${r.repo}: ${r.about}`).join("\n")}\n\n` : "";
	const properties = { type: { type: "string", enum: [...TYPES] }, name: { type: "string" }, ...(repos.length && { repo: { type: "string", enum: [...names, "none"] } }) };
	const picked = await llm.askJson(
		{
			name: "agent_route",
			system: SYSTEM,
			user: `${list}<task>\n${task}\n</task>`,
			schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
			reasoning: "none",
		},
		(text) => JSON.parse(text) as { repo?: string; type?: string; name?: string },
	);
	if (!picked) return {};
	// Тип іде префіксом (feat-…, fix-…): з гілки одразу видно, що це за робота; без придатного типу — лише назва.
	const type = TYPES.find((t) => t === picked.type);
	const name = cleanName(type && picked.name ? `${type}-${picked.name}` : picked.name);
	return { ...(picked.repo && names.includes(picked.repo) && { repo: picked.repo }), ...(name && { name }) };
}

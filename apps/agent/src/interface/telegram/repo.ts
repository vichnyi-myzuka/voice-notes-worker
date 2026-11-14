import type { Llm } from "@voice-notes/core";

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

const SYSTEM = `You route tasks for a coding agent. The owner dictates a task (usually in Ukrainian). Answer with:
- "type": the kind of work, like a conventional-commit type: feat (new capability), fix (bug), docs, refactor, test, chore (tooling, config, maintenance).
- "name": a short English kebab-case name for the task without the type, 2-4 words, only a-z, 0-9 and "-", e.g. "session-delete" or "readme-typos". Together with the type it becomes the folder and git branch name ("feat-session-delete"), so describe the work, not the wording of the request.
- "title": a short semantic title of the task in Ukrainian, 3-7 words, no trailing period, no emoji, e.g. "Семантичні назви тем у Telegram". It names the chat thread, so say what the work is about.
- "finance": true only if doing the task requires reading or changing the owner's own personal finance data kept in their finance tracker (Sure): their spending, income, transactions, accounts, balances, budgets, net worth, subscriptions, or the finance app itself by name (Sure, Shure, "шур"). false for everything else, including building a finance-related page, app or script, or tasks about money in general that need none of the owner's data.
- "groceries": true only if doing the task requires the owner's own purchase history from the Silpo supermarket (what products they bought, receipts, orders, grocery prices they paid, bonuses), or Silpo by name ("Сільпо", "silpo"). false for everything else, including generic questions about food, recipes or shops.
- "calendar": true only if doing the task requires reading or changing the owner's own Google Calendar: their schedule, meetings, appointments, events, free time, adding, moving or cancelling an event, or the calendar by name ("календар", "calendar"). false for everything else, including building a calendar page or app, or date arithmetic that needs none of the owner's events.
- "model": the Claude model the owner asks for anywhere in the task ("use Opus", "на опусі", "модель опус"), one of opus, sonnet, haiku. The task is dictated by voice and the speech recognizer garbles names, so treat close sounds as the same model ("опис", "опус", "Opus" -> opus; "сонет" -> sonnet; "хайку" -> haiku). "none" if the owner names no model; do not guess a model from the difficulty of the task.
- "evidence" (only if asked): an exact quote copied from the task where the owner explicitly refers to one of the known repositories (its name, or a phrase from its description such as "our bot" or "yourself", or a loose nickname, transliteration, misspelling or description of what the project is, such as "the bird game", or a named file or feature of that project). Empty string if there is no such quote.
- "unsure" (only if asked): true if the task may be about one of the known repositories but you cannot tell whether it is, or which one (vague words like "the project", "our thing", "the bot" when two repositories could fit, or a mention that is too loose to quote). false when the task clearly is about one repository (then give it), and false when it clearly is about none (a new standalone thing, a general question).
- "repo" (only if asked): the repository the evidence refers to, otherwise "none". Ukrainian is inflected, so "нашому боті", "нашого бота", "в нашому репозиторії", "у вас" (about the agent itself) count as the same phrases as "our bot", "our repository". Questions, ideas and research about a known project ("how can we improve X in our bot?", "що думаєш про наш бот") are about that project too, not only requests to change it. Default to "none" only when no known project is referred to. Creating something new and standalone (a page, a site, a script, a prototype, a report) is NEVER about a known repository, even if the topic sounds related; neither is a generic or ambiguous task.`;

export const MODELS = ["opus", "sonnet", "haiku"] as const;

export type Route = { repo?: string; unsure?: boolean; model?: string; name?: string; title?: string; sure?: boolean; silpo?: boolean; calendar?: boolean };

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const TYPES = ["feat", "fix", "docs", "refactor", "test", "chore"] as const;

// Назва з відповіді моделі приводиться до безпечного вигляду; непридатна (порожня, закоротка) відкидається.
export function cleanName(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
	return NAME.test(name) ? name : undefined;
}

// Один виклик моделі: назва для теки/гілки за змістом задачі, чи потрібні їй особисті фінанси власника (MCP Sure), покупки в Сільпо (MCP Сільпо), його Google Calendar (MCP Календаря) й (якщо є відомі репозиторії) репозиторій із вільної фрази
// («давай попрацюємо над нашим ботом»). Збій моделі дає порожній результат: сесія просто отримає технічну назву.
export async function routeTask(llm: Llm, repos: KnownRepo[], task: string): Promise<Route> {
	const names = repos.map((r) => r.repo);
	const list = repos.length ? `Known repositories:\n${repos.map((r) => `- ${r.repo}: ${r.about}`).join("\n")}\n\n` : "";
	// evidence перед repo: модель спершу наводить цитату, а потім вирішує; порядок властивостей зберігається.
	const properties = { type: { type: "string", enum: [...TYPES] }, name: { type: "string" }, title: { type: "string" }, finance: { type: "boolean" }, groceries: { type: "boolean" }, calendar: { type: "boolean" }, model: { type: "string", enum: [...MODELS, "none"] }, ...(repos.length && { evidence: { type: "string" }, unsure: { type: "boolean" }, repo: { type: "string", enum: [...names, "none"] } }) };
	const picked = await llm.askJson(
		{
			name: "agent_route",
			system: SYSTEM,
			user: `${list}<task>\n${task}\n</task>`,
			schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
			reasoning: "none",
		},
		(text) => JSON.parse(text) as { repo?: string; unsure?: boolean; evidence?: string; type?: string; name?: string; title?: string; finance?: boolean; groceries?: boolean; calendar?: boolean; model?: string },
	);
	if (!picked) return {};
	// Тип іде префіксом (feat-…, fix-…): з гілки одразу видно, що це за робота; без придатного типу — лише назва.
	const type = TYPES.find((t) => t === picked.type);
	const name = cleanName(type && picked.name ? `${type}-${picked.name}` : picked.name);
	const title = typeof picked.title === "string" ? picked.title.replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim().slice(0, 60) : "";
	// Репозиторій приймається лише з цитатою, що справді є у фразі: вигадане моделлю відкидається.
	const quote = picked.evidence?.trim().toLowerCase() ?? "";
	const grounded = quote.length >= 3 && task.toLowerCase().includes(quote);
	const model = MODELS.find((m) => m === picked.model);
	if (picked.repo && picked.repo !== "none" && !grounded) console.log(`route: repo ${picked.repo} відкинуто, цитата ${JSON.stringify(picked.evidence ?? "")} не знайдена у фразі`);
	const repo = grounded && picked.repo && names.includes(picked.repo) ? picked.repo : undefined;
	return { ...(!repo && picked.unsure === true && { unsure: true }), ...(model && { model }), ...(picked.finance === true && { sure: true }), ...(picked.groceries === true && { silpo: true }), ...(picked.calendar === true && { calendar: true }), ...(repo && { repo }), ...(name && { name }), ...(title && { title }) };
}

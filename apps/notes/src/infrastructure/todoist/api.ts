import type { SetupWorld, TrackerSnapshot } from "../../domain/tracker";
import type { Env } from "../env";
import type { SyncResult, TodoistCommand } from "./types";

export const SYNC_URL = "https://api.todoist.com/api/v1/sync";

// Службовий проєкт з правилами тріажу в описі. Може бути активним або в архіві; у тріажі не бере участі.
export const RULES_PROJECT = "⚙️ Правила";

export async function get<T>(env: Env, path: string): Promise<T> {
	const res = await fetch(`https://api.todoist.com/api/v1/${path}`, { headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` } });
	if (!res.ok) throw new Error(`Todoist ${path} ${res.status}: ${await res.text()}`);
	return res.json<T>();
}

async function sync<T>(env: Env, body: Record<string, string>): Promise<T> {
	const res = await fetch(SYNC_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` },
		body: new URLSearchParams(body),
	});
	if (!res.ok) throw new Error(`Todoist sync ${res.status}: ${await res.text()}`);
	return res.json<T>();
}

// Повний стан вказаних ресурсів (projects, labels, items).
export const readResources = <T>(env: Env, types: string[]) => sync<T>(env, { sync_token: "*", resource_types: JSON.stringify(types) });

// Виконує пакет команд; результат — статуси кожної.
export const runCommands = (env: Env, commands: TodoistCommand[]) => sync<SyncResult>(env, { commands: JSON.stringify(commands) });

type Project = { id: string; name: string; description?: string; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean };

export async function fetchSnapshot(env: Env): Promise<TrackerSnapshot> {
	const d = await readResources<{
		projects: Project[];
		labels: { name: string; is_deleted?: boolean }[];
		items: { content: string; checked?: boolean; is_deleted?: boolean }[];
	}>(env, ["projects", "labels", "items"]);
	const active = d.projects.filter((p) => !p.is_archived && !p.is_deleted);
	return {
		projects: active
			.filter((p) => p.name !== RULES_PROJECT)
			.map((p) => ({ id: p.id, name: p.name, inbox: !!p.inbox_project, ...(p.description?.trim() && { description: p.description.trim() }) })),
		labels: d.labels.filter((l) => !l.is_deleted).map((l) => l.name),
		tasks: d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.content),
		rules: ((await findRulesProject(env, active))?.description ?? "").trim(),
	};
}

// Знімок для тріажу; без токена або при збої — null (нотатка прийде без тріажу).
export async function trySnapshot(env: Env): Promise<TrackerSnapshot | null> {
	if (!env.TODOIST_TOKEN) return null;
	try {
		return await fetchSnapshot(env);
	} catch (err) {
		console.error("todoist snapshot failed:", err);
		return null;
	}
}

// Проєкти, мітки й правила для команд налаштування.
export async function fetchWorld(env: Env): Promise<SetupWorld> {
	const d = await readResources<{
		projects: Project[];
		labels: { id: string; name: string; is_deleted?: boolean }[];
		items: { project_id: string; checked?: boolean; is_deleted?: boolean }[];
	}>(env, ["projects", "labels", "items"]);
	const active = d.projects.filter((p) => !p.is_archived && !p.is_deleted);
	const open = d.items.filter((i) => !i.checked && !i.is_deleted);
	const rules = await findRulesProject(env, active);
	return {
		projects: active
			.filter((p) => !p.inbox_project && p.name !== RULES_PROJECT)
			.map((p) => ({ id: p.id, name: p.name, description: p.description ?? "", openTasks: open.filter((i) => i.project_id === p.id).length })),
		labels: d.labels.filter((l) => !l.is_deleted).map((l) => ({ id: l.id, name: l.name })),
		rules: rules && { id: rules.id, text: rules.description },
		reserved: ["Inbox", "Вхідні", RULES_PROJECT],
	};
}

// RULES_PROJECT серед активних проєктів або в архіві (архівних проєктів немає в /sync).
export async function findRulesProject(env: Env, active: Project[]): Promise<{ id: string; description: string } | null> {
	const own = active.find((p) => p.name === RULES_PROJECT);
	if (own) return { id: own.id, description: own.description ?? "" };
	let cursor = "";
	do {
		const page = await get<{ results?: Project[]; next_cursor?: string | null }>(
			env,
			`projects/archived?limit=200${cursor && `&cursor=${encodeURIComponent(cursor)}`}`,
		);
		const found = page.results?.find((p) => p.name === RULES_PROJECT);
		if (found) return { id: found.id, description: found.description ?? "" };
		const next = page.next_cursor ?? "";
		cursor = next !== cursor ? next : ""; // захист від зациклення
	} while (cursor);
	console.error(`Todoist project "${RULES_PROJECT}" not found: triage runs without rules`);
	return null;
}

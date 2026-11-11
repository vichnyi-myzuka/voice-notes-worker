import type { Env } from "../env";
import { RULES_PROJECT } from "./constants";
import type { TodoistSnapshot } from "./types";

export const SYNC_URL = "https://api.todoist.com/api/v1/sync";

export async function get(env: Env, path: string): Promise<Record<string, unknown>> {
	const res = await fetch(`https://api.todoist.com/api/v1/${path}`, { headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` } });
	if (!res.ok) throw new Error(`Todoist ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

export async function sync(env: Env, body: Record<string, string>): Promise<Record<string, unknown>> {
	const res = await fetch(SYNC_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` },
		body: new URLSearchParams(body),
	});
	if (!res.ok) throw new Error(`Todoist sync ${res.status}: ${await res.text()}`);
	return res.json();
}

export async function fetchSnapshot(env: Env): Promise<TodoistSnapshot> {
	const d = (await sync(env, { sync_token: "*", resource_types: JSON.stringify(["projects", "labels", "items"]) })) as {
		projects: { id: string; name: string; description?: string; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean }[];
		labels: { name: string; is_deleted?: boolean }[];
		items: { content: string; checked?: boolean; is_deleted?: boolean }[];
	};
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

// RULES_PROJECT серед активних проєктів або в архіві (архівних проєктів немає в /sync).
export async function findRulesProject(
	env: Env,
	active: { id: string; name: string; description?: string }[],
): Promise<{ id: string; description: string } | null> {
	const own = active.find((p) => p.name === RULES_PROJECT);
	if (own) return { id: own.id, description: own.description ?? "" };
	let cursor = "";
	do {
		const page = (await get(env, `projects/archived?limit=200${cursor && `&cursor=${encodeURIComponent(cursor)}`}`)) as {
			results?: { id: string; name: string; description?: string }[];
			next_cursor?: string | null;
		};
		const found = page.results?.find((p) => p.name === RULES_PROJECT);
		if (found) return { id: found.id, description: found.description ?? "" };
		const next = page.next_cursor ?? "";
		cursor = next !== cursor ? next : ""; // захист від зациклення
	} while (cursor);
	console.error(`Todoist project "${RULES_PROJECT}" not found: triage runs without rules`);
	return null;
}

// Знімок Todoist для тріажу; без токена або при збої — null (нотатка прийде без тріажу).
export async function trySnapshot(env: Env): Promise<TodoistSnapshot | null> {
	if (!env.TODOIST_TOKEN) return null;
	try {
		return await fetchSnapshot(env);
	} catch (err) {
		console.error("todoist snapshot failed:", err);
		return null;
	}
}

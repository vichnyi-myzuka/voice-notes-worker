import type { Env } from "../env";
import { askJson, parseJsonObject } from "../llm";
import { RULES_PROJECT, findRulesProject, sync } from "../todoist";
import type { SetupPlan, SetupWorld } from "./types";
import { validateSetup } from "./validate";

// Дешевий фільтр: без цих слів модель не викликаємо.
export const MENTION = /про[еєe]кт|project|мітк|лейбл|label|тег/i;

export async function fetchWorld(env: Env): Promise<SetupWorld> {
	const d = (await sync(env, { sync_token: "*", resource_types: JSON.stringify(["projects", "labels", "items"]) })) as {
		projects: { id: string; name: string; description?: string; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean }[];
		labels: { id: string; name: string; is_deleted?: boolean }[];
		items: { project_id: string; checked?: boolean; is_deleted?: boolean }[];
	};
	const active = d.projects.filter((p) => !p.is_archived && !p.is_deleted);
	const open = d.items.filter((i) => !i.checked && !i.is_deleted);
	const rules = await findRulesProject(env, active);
	return {
		projects: active
			.filter((p) => !p.inbox_project && p.name !== RULES_PROJECT)
			.map((p) => ({ id: p.id, name: p.name, description: p.description ?? "", openTasks: open.filter((i) => i.project_id === p.id).length })),
		labels: d.labels.filter((l) => !l.is_deleted).map((l) => ({ id: l.id, name: l.name })),
		rules: rules && { id: rules.id, text: rules.description },
	};
}

export const SETUP_SYSTEM = `You find commands that change the author's Todoist setup in a Ukrainian voice note or edit instruction: create, rename or delete a project or a label ("мітка", "тег"), or change its description.
Only explicit commands to the assistant count: "створи проєкт Спорт", "додай мітку Online — для онлайн-справ", "перейменуй проєкт Home на Дім", "видали мітку Office", "зміни опис проєкту Work: …". A mention of a real-world project ("треба почати новий проєкт", "проєкт для клієнта") or a task about a project is not a command. Speech recognition often garbles the imperative ("створив" for "створи", "Project" for "проєкт"): when the author speaks about creating, renaming or deleting a project or label in Todoist itself, treat it as a command. If there are no commands, return an empty list.
For each command:
- kind: "project" or "label".
- action: "create", "rename", "delete" or "describe" (change only the description).
- name: for an existing project or label, copy its name exactly from <projects> / <labels> (match by meaning: "дім" → "Home"); for create, the new name as the author said it, capitalized, without the words "проєкт" / "мітка".
- new_name: for rename, the new name; otherwise "".
- description: what the project is for, or when to use the label, if the author said it (Ukrainian, one short phrase starting with a lowercase letter, no trailing period); for describe, the new description; otherwise "".`;

export const SETUP_SCHEMA = {
	type: "object",
	properties: {
		changes: {
			type: "array",
			items: {
				type: "object",
				properties: {
					kind: { type: "string", enum: ["project", "label"] },
					action: { type: "string", enum: ["create", "rename", "delete", "describe"] },
					name: { type: "string" },
					new_name: { type: "string" },
					description: { type: "string" },
				},
				required: ["kind", "action", "name", "new_name", "description"],
				additionalProperties: false,
			},
		},
	},
	required: ["changes"],
	additionalProperties: false,
};

// Команди налаштування з тексту запису чи правки. Збій — виняток (ретрай), на останній спробі — порожній план.
export async function planSetup(env: Env, text: string, lastAttempt: boolean): Promise<SetupPlan> {
	const none: SetupPlan = { changes: [] };
	if (!env.TODOIST_TOKEN || !MENTION.test(text)) return none;
	try {
		const world = await fetchWorld(env);
		const user = [
			`<projects>\n${world.projects.map((p) => (p.description ? `${p.name} — ${p.description}` : p.name)).join("\n")}\n</projects>`,
			`<labels>\n${world.labels.map((l) => l.name).join("\n")}\n</labels>`,
			`<text>\n${text}\n</text>`,
		].join("\n\n");
		const plan = await askJson(env, { name: "todoist_setup", system: SETUP_SYSTEM, user, schema: SETUP_SCHEMA, reasoning: "low" }, (t) => {
			const raw = parseJsonObject(t).changes;
			if (!Array.isArray(raw)) throw new Error("no changes");
			return validateSetup(raw, world);
		});
		if (!plan) throw new Error("All setup models failed");
		return plan;
	} catch (err) {
		if (!lastAttempt) throw err;
		console.error("todoist setup failed:", err);
		return none;
	}
}

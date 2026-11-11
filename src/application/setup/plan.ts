import type { Env } from "../../infrastructure/env";
import { askJson, isJsonObject, parseJsonObject, type Json, type JsonObject } from "../../infrastructure/llm";
import { labelRule, setLabelRule } from "./rules";
import type { SetupChange, SetupPlan, SetupWorld, TaskTracker } from "../../domain/tracker";

// Дешевий фільтр: без цих слів модель не викликаємо.
export const MENTION = /про[еєe]кт|project|мітк|лейбл|label|тег/i;

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
export async function planSetup(env: Env, tracker: TaskTracker, text: string, lastAttempt: boolean): Promise<SetupPlan> {
	const none: SetupPlan = { changes: [] };
	if (!tracker.enabled || !MENTION.test(text)) return none;
	try {
		const world = await tracker.world();
		const user = [
			`<projects>\n${world.projects.map((p) => (p.description ? `${p.name} — ${p.description}` : p.name)).join("\n")}\n</projects>`,
			`<labels>\n${world.labels.map((l) => l.name).join("\n")}\n</labels>`,
			`<text>\n${text}\n</text>`,
		].join("\n\n");
		const plan = await askJson(env, { name: "todoist_setup", system: SETUP_SYSTEM, user, schema: SETUP_SCHEMA, reasoning: "low" }, (t) => {
			const raw = parseJsonObject(t).changes;
			if (!Array.isArray(raw)) throw new Error("no changes");
			return validateSetup(raw.filter(isJsonObject), world);
		});
		if (!plan) throw new Error("All setup models failed");
		return plan;
	} catch (err) {
		if (!lastAttempt) throw err;
		console.error("todoist setup failed:", err);
		return none;
	}
}

const ACTIONS: SetupChange["action"][] = ["create", "rename", "delete", "describe"];

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export const clean = (v: Json | undefined) => String(v ?? "").replace(/^[@#]/, "").replace(/\s+/g, " ").trim();

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Перевіряє команди моделі по черзі (наступна бачить результат попередньої): лише існуючі проєкти й мітки,
// без конфліктів імен; Inbox і RULES_PROJECT не чіпаємо. Описи міток переносяться в текст правил.
export function validateSetup(raw: JsonObject[], world: SetupWorld): SetupPlan {
	type Entry = { id?: string; name: string; description?: string; openTasks?: number };
	const lists: Record<SetupChange["kind"], Entry[]> = {
		project: world.projects.map((p) => ({ ...p })),
		label: world.labels.map((l) => ({ ...l, description: labelRule(world.rules?.text ?? "", l.name) })),
	};
	const reserved = new Set(world.reserved.map(norm));
	let rules = world.rules?.text ?? "";
	const changes: SetupChange[] = [];
	for (const r of raw) {
		const kind = r.kind === "project" || r.kind === "label" ? r.kind : null;
		const action = ACTIONS.find((a) => a === r.action) ?? null;
		const name = clean(r.name);
		const newName = clean(r.new_name);
		// Опис мітки без правил нема де зберегти.
		const description = kind === "label" && !world.rules ? "" : String(r.description ?? "").replace(/\s+/g, " ").trim();
		if (!kind || !action || !name) continue;
		const list = lists[kind];
		const find = (n: string) => list.find((e) => norm(e.name) === norm(n));
		const existing = find(name);
		// Мітки з пробілами Todoist не розбирає у швидкому додаванні.
		const badName = (n: string) => reserved.has(norm(n)) || (kind === "label" && /\s/.test(n));
		const labelLine = (n: string, desc: string) => (kind === "label" && world.rules ? setLabelRule(rules, n, desc) : rules);

		if (action === "create" && !existing) {
			if (badName(name)) continue;
			changes.push({ kind, action, name, newName: "", description });
			list.push({ name, description });
			if (description) rules = labelLine(name, description);
		} else if ((action === "describe" || action === "create") && existing?.id && description) {
			changes.push({ kind, action: "describe", name: existing.name, newName: "", description, id: existing.id });
			existing.description = description;
			rules = labelLine(existing.name, description);
		} else if (action === "rename" && existing?.id && newName && !badName(newName)) {
			const clash = find(newName);
			if ((clash && clash !== existing) || existing.name === newName) continue;
			changes.push({ kind, action, name: existing.name, newName, description, id: existing.id });
			if (kind === "label" && world.rules) {
				rules = setLabelRule(rules, existing.name, null);
				const desc = description || existing.description;
				if (desc) rules = setLabelRule(rules, newName, desc);
			}
			existing.name = newName;
			if (description) existing.description = description;
		} else if (action === "delete" && existing?.id) {
			changes.push({ kind, action, name: existing.name, newName: "", description: "", id: existing.id, ...(kind === "project" && { openTasks: existing.openTasks ?? 0 }) });
			list.splice(list.indexOf(existing), 1);
			if (kind === "label" && world.rules) rules = setLabelRule(rules, existing.name, null);
		}
	}
	return { changes, ...(world.rules && rules !== world.rules.text && { rules: { projectId: world.rules.id, text: rules } }) };
}

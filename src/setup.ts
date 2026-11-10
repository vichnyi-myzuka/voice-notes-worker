import type { Env } from "./index";
import { askJson, parseJsonObject } from "./llm";
import { findRulesProject, RULES_PROJECT, sync } from "./todoist";

// Голосові команди налаштування Todoist: створити, перейменувати, видалити проєкт чи мітку або змінити опис.
// Опис проєкту — у самому проєкті; опис мітки — рядок «Мітка — коли ставити» в секції [мітки] проєкту RULES_PROJECT.

export type SetupChange = {
	kind: "project" | "label";
	action: "create" | "rename" | "delete" | "describe";
	name: string;
	newName: string;
	description: string;
	id?: string; // id існуючого проєкту чи мітки в Todoist
	openTasks?: number; // (видалення проєкту) відкриті задачі в ньому: тоді архівуємо замість видалення
};
// rules: новий текст опису RULES_PROJECT, якщо змінились описи міток.
export type SetupPlan = { changes: SetupChange[]; rules?: { projectId: string; text: string } };

// Що є в Todoist: проєкти без Inbox і RULES_PROJECT, мітки, проєкт правил.
export type SetupWorld = {
	projects: { id: string; name: string; description: string; openTasks: number }[];
	labels: { id: string; name: string }[];
	rules: { id: string; text: string } | null;
};

// Дешевий фільтр: без цих слів модель не викликаємо.
const MENTION = /про[еєe]кт|project|мітк|лейбл|label|тег/i;

async function fetchWorld(env: Env): Promise<SetupWorld> {
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

const SETUP_SYSTEM = `You find commands that change the author's Todoist setup in a Ukrainian voice note or edit instruction: create, rename or delete a project or a label ("мітка", "тег"), or change its description.
Only explicit commands to the assistant count: "створи проєкт Спорт", "додай мітку Online — для онлайн-справ", "перейменуй проєкт Home на Дім", "видали мітку Office", "зміни опис проєкту Work: …". A mention of a real-world project ("треба почати новий проєкт", "проєкт для клієнта") or a task about a project is not a command. Speech recognition often garbles the imperative ("створив" for "створи", "Project" for "проєкт"): when the author speaks about creating, renaming or deleting a project or label in Todoist itself, treat it as a command. If there are no commands, return an empty list.
For each command:
- kind: "project" or "label".
- action: "create", "rename", "delete" or "describe" (change only the description).
- name: for an existing project or label, copy its name exactly from <projects> / <labels> (match by meaning: "дім" → "Home"); for create, the new name as the author said it, capitalized, without the words "проєкт" / "мітка".
- new_name: for rename, the new name; otherwise "".
- description: what the project is for, or when to use the label, if the author said it (Ukrainian, one short phrase starting with a lowercase letter, no trailing period); for describe, the new description; otherwise "".`;

const SETUP_SCHEMA = {
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

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const clean = (v: unknown) => String(v ?? "").replace(/^[@#]/, "").replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Перевіряє команди моделі по черзі (наступна бачить результат попередньої): лише існуючі проєкти й мітки,
// без конфліктів імен; Inbox і RULES_PROJECT не чіпаємо. Описи міток переносяться в текст правил.
export function validateSetup(raw: Record<string, unknown>[], world: SetupWorld): SetupPlan {
	type Entry = { id?: string; name: string; description?: string; openTasks?: number };
	const lists: Record<SetupChange["kind"], Entry[]> = {
		project: world.projects.map((p) => ({ ...p })),
		label: world.labels.map((l) => ({ ...l, description: labelRule(world.rules?.text ?? "", l.name) })),
	};
	const reserved = new Set(["inbox", "вхідні", norm(RULES_PROJECT)]);
	let rules = world.rules?.text ?? "";
	const changes: SetupChange[] = [];
	for (const r of raw) {
		const kind = r.kind === "project" || r.kind === "label" ? r.kind : null;
		const action = ["create", "rename", "delete", "describe"].includes(String(r.action)) ? (r.action as SetupChange["action"]) : null;
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

// ---------- Описи міток у тексті правил (секція [мітки], рядки «Мітка — опис») ----------
const SECTION = "[мітки]";
const ruleRe = (name: string) => new RegExp(`^\\s*${escapeRe(name)}\\s*[—–-]\\s*`, "i");

function labelSection(lines: string[]): [number, number] | null {
	const start = lines.findIndex((l) => l.trim().toLowerCase() === SECTION);
	if (start < 0) return null;
	const next = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
	return [start, next < 0 ? lines.length : next];
}

// Опис мітки з правил або "".
export function labelRule(rules: string, name: string): string {
	const lines = rules.split("\n");
	const sec = labelSection(lines);
	if (!sec) return "";
	const line = lines.slice(sec[0] + 1, sec[1]).find((l) => ruleRe(name).test(l));
	return line ? line.replace(ruleRe(name), "").trim() : "";
}

// Ставить («Мітка — опис») або прибирає (description = null) рядок мітки в секції [мітки].
export function setLabelRule(rules: string, name: string, description: string | null): string {
	const lines = rules.split("\n");
	const line = description ? `${name} — ${description}` : null;
	const sec = labelSection(lines);
	if (!sec) return line ? `${rules.trimEnd()}${rules.trim() ? "\n\n" : ""}${SECTION}\n${line}` : rules;
	const [start, end] = sec;
	const at = lines.findIndex((l, i) => i > start && i < end && ruleRe(name).test(l));
	if (at >= 0) {
		if (line) lines[at] = line;
		else lines.splice(at, 1);
	} else if (line) {
		let last = end - 1;
		while (last > start && !lines[last].trim()) last--; // після останнього непорожнього рядка секції
		lines.splice(last + 1, 0, line);
	}
	return lines.join("\n");
}

// ---------- Виконання ----------
// Команди /sync. uuid сталі (id плану + номер), тож ретрай не виконає їх вдруге.
export function setupCommands(id: string, plan: SetupPlan): object[] {
	const cmds = plan.changes.flatMap((c, i): object[] => {
		const uuid = `${id}-s${i}`;
		const desc = c.description ? { description: c.description } : {};
		if (c.kind === "project") {
			if (c.action === "create") return [{ type: "project_add", uuid, temp_id: `tmp-${uuid}`, args: { name: c.name, ...desc } }];
			if (c.action === "rename") return [{ type: "project_update", uuid, args: { id: c.id, name: c.newName, ...desc } }];
			if (c.action === "describe") return [{ type: "project_update", uuid, args: { id: c.id, description: c.description } }];
			// Проєкт з відкритими задачами не видаляємо (зникли б і задачі), а архівуємо: його можна повернути.
			return [{ type: c.openTasks ? "project_archive" : "project_delete", uuid, args: { id: c.id } }];
		}
		if (c.action === "create") return [{ type: "label_add", uuid, temp_id: `tmp-${uuid}`, args: { name: c.name } }];
		if (c.action === "rename") return [{ type: "label_update", uuid, args: { id: c.id, name: c.newName } }];
		if (c.action === "delete") return [{ type: "label_delete", uuid, args: { id: c.id } }]; // знімає мітку з задач
		return []; // опис мітки живе лише в правилах
	});
	if (plan.rules) cmds.push({ type: "project_update", uuid: `${id}-rules`, args: { id: plan.rules.projectId, description: plan.rules.text } });
	return cmds;
}

export async function applySetup(env: Env, id: string, plan: SetupPlan): Promise<void> {
	const commands = setupCommands(id, plan);
	if (!commands.length) return;
	const res = (await sync(env, { commands: JSON.stringify(commands) })) as { sync_status: Record<string, unknown> };
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");
	if (errors.length) throw new Error(`Todoist setup failed: ${JSON.stringify(errors)}`);
}

// Рядки для підпису нотатки.
export function setupReport(plan: SetupPlan): string[] {
	return plan.changes.map((c) => {
		const what = c.kind === "project" ? "Проєкт" : "Мітка";
		const desc = c.description ? ` — ${c.description}` : "";
		if (c.action === "create") return `➕ ${what} «${c.name}»${desc}`;
		if (c.action === "rename") return `✏️ ${what} «${c.name}» → «${c.newName}»${desc}`;
		if (c.action === "describe") return `📝 ${what} «${c.name}»${desc}`;
		if (c.openTasks) return `🗄 Проєкт «${c.name}» в архіві (відкритих задач у ньому: ${c.openTasks})`;
		return `🗑 ${what} «${c.name}» видалено`;
	});
}

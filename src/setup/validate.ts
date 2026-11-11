import { RULES_PROJECT } from "../todoist";
import { labelRule, setLabelRule } from "./rules";
import type { SetupChange, SetupPlan, SetupWorld } from "./types";
import { clean, norm } from "./utils";

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

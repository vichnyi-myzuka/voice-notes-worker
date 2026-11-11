import type { Env } from "../env";
import type { Steps } from "../steps";
import { sync } from "../todoist";
import { planSetup } from "./plan";
import type { SetupPlan, SetupState } from "./types";

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

export const SETUP_FAILED = "⚠️ Не вдалося змінити проєкти чи мітки";

// Команди налаштування з тексту: план зберігається в стані, виконання ідемпотентне (сталі uuid).
// Повертає рядки звіту для підпису ([] — команд не було).
export async function runSetup(env: Env, text: string, run: Steps<SetupState>): Promise<string[]> {
	const s = await run.step("setup", async () => {
		const plan = await planSetup(env, text, run.lastAttempt);
		return plan.changes.length ? { id: crypto.randomUUID(), plan } : null;
	});
	if (!s) return [];
	const ok = await run.step(
		"setupApplied",
		async () => {
			await applySetup(env, s.id, s.plan);
			console.log(`todoist setup ${s.id}: ${s.plan.changes.length} changes, applied`);
			return true;
		},
		{ onFinalFailure: () => false },
	);
	return ok ? setupReport(s.plan) : [SETUP_FAILED];
}

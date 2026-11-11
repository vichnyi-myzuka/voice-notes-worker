import type { Llm } from "../../domain/llm";
import type { Steps } from "../../infrastructure/steps";
import { planSetup } from "./plan";
import type { SetupPlan, TaskTracker } from "../../domain/tracker";
import type { SetupState } from "./types";

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
export async function runSetup(llm: Llm, tracker: TaskTracker, text: string, run: Steps<SetupState>): Promise<string[]> {
	const s = await run.step("setup", async () => {
		const plan = await planSetup(llm, tracker, text, run.lastAttempt);
		return plan.changes.length ? { id: crypto.randomUUID(), plan } : null;
	});
	if (!s) return [];
	const ok = await run.step(
		"setupApplied",
		async () => {
			await tracker.applySetup(s.id, s.plan);
			console.log(`todoist setup ${s.id}: ${s.plan.changes.length} changes, applied`);
			return true;
		},
		{ onFinalFailure: () => false },
	);
	return ok ? setupReport(s.plan) : [SETUP_FAILED];
}

import type { Env } from "../env";
import type { Steps } from "../steps";
import { applySetup, setupReport } from "./apply";
import { planSetup } from "./plan";
import type { SetupState } from "./types";

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

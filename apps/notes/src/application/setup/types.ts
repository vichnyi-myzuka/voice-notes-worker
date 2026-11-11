import type { SetupPlan } from "../../domain/tracker";

export type SetupState = {
	setup?: { id: string; plan: SetupPlan } | null; // команди налаштування трекера (null — немає)
	setupApplied?: boolean; // команди виконано (false — не вдалося навіть на останній спробі)
};

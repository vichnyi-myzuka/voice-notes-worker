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

export type SetupState = {
	setup?: { id: string; plan: SetupPlan } | null; // команди налаштування Todoist (null — немає)
	setupApplied?: boolean; // команди виконано (false — не вдалося навіть на останній спробі)
};

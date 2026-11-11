import type { TriageItem } from "../../infrastructure/todoist";

// Що з нотатки вже є в Todoist (за ключем задачі).
export type InTodoist = Record<string, { id: string; item: TriageItem; reminderIds?: string[] }>;

// Без id — створити; з id і item — оновити (move: змінився проєкт; reminders: перестворити нагадування,
// oldReminderIds — що видалити; describe: змінились подробиці, переписати опис); з id без item — видалити.
export type TodoistOp = {
	key: string;
	item: TriageItem | null;
	id?: string;
	move?: boolean;
	reminders?: boolean;
	oldReminderIds?: string[];
	describe?: boolean;
};

// Виконує операції в Todoist і оновлює стан задач нотатки (InTodoist).
// Команди мають сталі uuid (runId + номер операції), тож ретрай не виконає їх удруге.
export type ApplyParams = { noteId: string; runId: string; ops: TodoistOp[]; description: string; messageUrl?: string };

// Задачі нотатки в Todoist: план змін (ops) → виконання. Кроки зберігаються в стані обробки:
// ops фіксуються раз (uuid команд не змінюються при ретраї), actionId — id запуску, todoistApplied — результат.
// Повертає undefined, якщо змін немає; false — не вдалося навіть на останній спробі (нотатка все одно дійде).
export type SyncState = { ops?: TodoistOp[]; actionId?: string; todoistApplied?: boolean };

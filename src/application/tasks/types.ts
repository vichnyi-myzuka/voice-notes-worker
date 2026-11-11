import type { TaskOp } from "../../domain/tracker";

// Виконує операції в трекері й оновлює стан задач нотатки (TrackedTasks).
// Команди мають сталі id (runId + номер операції), тож ретрай не виконає їх удруге.
export type ApplyParams = { noteId: string; runId: string; ops: TaskOp[]; description: string; messageUrl?: string };

// Задачі нотатки в трекері: план змін (ops) → виконання. Кроки зберігаються в стані обробки:
// ops фіксуються раз (id команд не змінюються при ретраї), actionId — id запуску, tasksApplied — результат.
// Повертає undefined, якщо змін немає; false — не вдалося навіть на останній спробі (нотатка все одно дійде).
export type SyncState = { ops?: TaskOp[]; actionId?: string; tasksApplied?: boolean };

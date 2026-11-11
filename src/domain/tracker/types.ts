// Що є в трекері задач зараз: воркер читає це перед тріажем.
export type TrackerSnapshot = {
	projects: { id: string; name: string; inbox: boolean; description?: string }[]; // опис — пояснення для тріажу
	labels: string[];
	tasks: string[]; // назви відкритих задач — для пошуку дублікатів
	rules: string; // правила автора: мітки, пріоритети, загальні правила
};

// Задача з нотатки після тріажу.
export type TriageItem = {
	title: string;
	duplicateOf: string; // назва існуючої відкритої задачі або ""
	project: string; // назва проєкту або "" (Inbox)
	labels: string[];
	priority: number; // 1 (p1, найвищий) … 4 (p4, без пріоритету)
	due: string; // YYYY-MM-DD | YYYY-MM-DDTHH:MM (з часом) | ""
	deadline: string; // YYYY-MM-DD | "" (лише дата)
	recurrence?: string; // повтор фразою трекера англійською ("every monday at 9:00") | "" ; due — перше виконання
	recurrenceLabel?: string; // той самий повтор українською для підпису ("щопонеділка о 9:00")
	details?: string; // подробиці з запису, що не влізли в назву: ідуть в опис задачі; немає в старих нотатках
	reminders?: string[]; // "before:<хв>" (до часу виконання) | YYYY-MM-DDTHH:MM; немає в нотатках до появи нагадувань
	key?: string; // стабільний ключ задачі в нотатці (t1, t2…): за ним редагування знаходить задачу в трекері
};

// Що з нотатки вже є в трекері (за ключем задачі).
export type TrackedTasks = Record<string, { id: string; item: TriageItem; reminderIds?: string[] }>;

// Без id — створити; з id і item — оновити (move: змінився проєкт; reminders: перестворити нагадування,
// oldReminderIds — що видалити; describe: змінились подробиці, переписати опис); з id без item — видалити.
export type TaskOp = {
	key: string;
	item: TriageItem | null;
	id?: string;
	move?: boolean;
	reminders?: boolean;
	oldReminderIds?: string[];
	describe?: boolean;
};

// Результат однієї операції (за порядком ops). item — задача такою, якою її прийняв трекер
// (наприклад, без повтору, якого він не розпізнав); reminderIds — лише нові нагадування.
export type OpResult = { ok: boolean; id?: string; item: TriageItem | null; reminderIds?: string[] };

// errors — відхилені команди; результати успішних операцій потрібні й при частковому збої.
export type ApplyResult = { results: OpResult[]; errors: string[] };

export type SetupChange = {
	kind: "project" | "label";
	action: "create" | "rename" | "delete" | "describe";
	name: string;
	newName: string;
	description: string;
	id?: string; // id існуючого проєкту чи мітки в трекері
	openTasks?: number; // (видалення проєкту) відкриті задачі в ньому: тоді архівуємо замість видалення
};

// rules: новий текст правил (projectId — де вони зберігаються в трекері), якщо змінились описи міток.
export type SetupPlan = { changes: SetupChange[]; rules?: { projectId: string; text: string } };

// Що є в трекері: проєкти без службових, мітки, правила; reserved — імена, які не можна створювати.
export type SetupWorld = {
	projects: { id: string; name: string; description: string; openTasks: number }[];
	labels: { id: string; name: string }[];
	rules: { id: string; text: string } | null;
	reserved: string[];
};

// Трекер задач (зараз Todoist). Ядро знає лише цей інтерфейс.
export interface TaskTracker {
	enabled: boolean; // false: токена немає, нотатки йдуть без тріажу
	// Знімок для тріажу; null — трекер вимкнений або недоступний (нотатка прийде без тріажу).
	snapshot: () => Promise<TrackerSnapshot | null>;
	triage: (transcript: string, tasks: string[], snap: TrackerSnapshot, recordedAt: Date) => Promise<TriageItem[] | null>;
	// Словник трекера для моделі, що редагує нотатку.
	prompts: {
		help: string;
		rulesBlock: (snap: TrackerSnapshot) => string;
		fieldsSchema: (snap: TrackerSnapshot) => Record<string, unknown>;
		validator: (snap: TrackerSnapshot, base: Date) => (raw: Record<string, unknown>) => TriageItem;
	};
	// Виконує операції; runId і номер операції дають сталі id команд, тож ретрай не виконає їх удруге.
	applyOps: (runId: string, ops: TaskOp[], description: string) => Promise<ApplyResult>;
	attachFile: (runId: string, taskIds: string[], file: Blob, fileName: string) => Promise<void>;
	// Видаляє задачі, що ще відкриті. Повертає кількість видалених.
	deleteOpenTasks: (ids: string[]) => Promise<number>;
	taskUrl: (id: string) => string;
	world: () => Promise<SetupWorld>;
	applySetup: (id: string, plan: SetupPlan) => Promise<void>;
}

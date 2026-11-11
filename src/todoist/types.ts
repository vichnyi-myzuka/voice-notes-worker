// Що є в Todoist зараз: воркер читає це з API перед тріажем.
export type TodoistSnapshot = {
	projects: { id: string; name: string; inbox: boolean; description?: string }[]; // опис — пояснення для тріажу
	labels: string[];
	tasks: string[]; // назви відкритих задач — для пошуку дублікатів
	rules: string; // опис службового проєкту RULES_PROJECT: мітки, пріоритети, загальні правила
};

// Задача з нотатки після тріажу.
export type TriageItem = {
	title: string;
	duplicateOf: string; // назва існуючої відкритої задачі або ""
	project: string; // назва проєкту або "" (Inbox)
	labels: string[];
	priority: number; // як у додатку: 1 (p1, найвищий) … 4 (p4, без пріоритету)
	due: string; // YYYY-MM-DD | YYYY-MM-DDTHH:MM (з часом) | ""
	deadline: string; // YYYY-MM-DD | "" (у Todoist дедлайн — лише дата)
	recurrence?: string; // повтор для Todoist англійською ("every monday at 9:00") | "" ; due — перше виконання
	recurrenceLabel?: string; // той самий повтор українською для підпису ("щопонеділка о 9:00")
	details?: string; // подробиці з запису, що не влізли в назву: ідуть в опис задачі в Todoist; немає в старих нотатках
	reminders?: string[]; // "before:<хв>" (до часу виконання) | YYYY-MM-DDTHH:MM; немає в нотатках до появи нагадувань
	key?: string; // стабільний ключ задачі в нотатці (t1, t2…): за ним редагування знаходить задачу в Todoist
};

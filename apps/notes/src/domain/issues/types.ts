// Репозиторій, у який можуть потрапляти issues: опис потрібен моделі, щоб відрізнити роботу над проєктом від решти.
export type IssueRepo = { repo: string; description: string }; // repo — "власник/назва"

// Що з нотатки вже є в GitHub (за ключем задачі). title і details — те, з чим створили чи оновили issue.
export type TrackedIssues = Record<string, { repo: string; number: number; url: string; title: string; details: string }>;

// Порт збереження issues нотатки (зараз R2).
export type IssueLedger = {
	get(noteId: string): Promise<TrackedIssues>;
	save(noteId: string, tracked: TrackedIssues): Promise<void>;
	remove(noteId: string): Promise<void>;
};

// Створити issue, оновити або закрити (GitHub не дає видалити issue через API: закриваємо як «not planned»).
export type IssueOp =
	| { kind: "create"; key: string; repo: string; title: string; details: string }
	| { kind: "update"; key: string; title: string; details: string }
	| { kind: "close"; key: string };

// Трекер issues (зараз GitHub). Ядро знає лише цей інтерфейс.
export interface IssueTracker {
	enabled: boolean; // false: токена чи списку репозиторіїв немає, issues не створюємо
	repos: IssueRepo[];
	create: (repo: string, issue: { title: string; body: string }) => Promise<{ number: number; url: string }>;
	update: (repo: string, number: number, issue: { title: string; body: string }) => Promise<void>;
	close: (repo: string, number: number, comment: string) => Promise<void>;
}

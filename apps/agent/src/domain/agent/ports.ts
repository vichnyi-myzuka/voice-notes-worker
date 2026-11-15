import type { FormAnswers, LastShown, PostEdit, PendingForm, Job, LimitWait, OpencodeEvent, PostAnswers, PromptFile, SessionInfo, Tracked, TopicState, Watch } from "./records";
import type { DeployInfo, PostRef, WatchTarget } from "./types";

// Порти, через які ядро агента (application) торкається зовнішнього світу. Реалізації — в infrastructure/container.

// Записи сесій: сесії, спостереження, прийняті завдання й очікування лімітів. Ядро працює з id сесії, а ключі знає лише реалізація.
export interface SessionStore {
	session(id: string): Promise<Tracked | undefined>;
	saveSession(id: string, tracked: Tracked): Promise<void>;
	dropSession(id: string): Promise<unknown>;
	sessions(): Promise<[string, Tracked][]>;
	sessionByOc(ocId: string): Promise<[string, Tracked] | undefined>;
	// Сесія гілки agent/<folder>: репозиторій той самий або не визначений (anyRepo), якщо так дозволено.
	sessionByBranch(repo: string, folder: string, anyRepo: boolean): Promise<[string, Tracked] | undefined>;
	watch(id: string): Promise<Watch | undefined>;
	saveWatch(id: string, w: Watch): Promise<void>;
	dropWatch(id: string): Promise<unknown>;
	watches(): Promise<[string, Watch][]>;
	watchByOc(ocId: string): Promise<[string, Watch] | undefined>;
	watching(): Promise<boolean>;
	job(id: string): Promise<Job | undefined>;
	saveJob(job: Job): Promise<void>;
	dropJob(id: string): Promise<unknown>;
	jobs(): Promise<Job[]>;
	form(id: string): Promise<PendingForm | undefined>;
	saveForm(id: string, form: PendingForm): Promise<void>;
	dropForm(id: string): Promise<unknown>;
	forms(): Promise<[string, PendingForm][]>;
	limit(id: string): Promise<LimitWait | undefined>;
	saveLimit(id: string, wait: LimitWait): Promise<void>;
	dropLimit(id: string): Promise<unknown>;
	limits(): Promise<[string, LimitWait][]>;
}

// Планувальник: коли воркер має прокинутись (alarm) і як лишити роботу у фоні після відповіді.
export interface Scheduler {
	now(): Promise<void>; // прокинутись негайно
	noLater(at: number): Promise<void>; // прокинутись не пізніше за мить at (мс від epoch)
	background(work: Promise<unknown>): void;
}

// Повідомлення власнику в чаті. Без налаштованого бота нічого не робить.
export interface Notices {
	readonly enabled: boolean;
	// Показує стан у пості сесії (оновлює його на місці); false, якщо поста немає.
	show(id: string, target: WatchTarget, text: string, final?: boolean): Promise<boolean>;
	// Окреме повідомлення в тему сесії; кнопка kind: «retry» (повторити) чи «done».
	send(id: string, target: { chatId: number; url: string; threadId?: number }, text: string, kind: "retry" | "done"): Promise<void>;
}

// Ліміти підписки Claude: чи є чим їх перевіряти і що вони показують.
export interface LimitProbe {
	readonly configured: boolean;
	read(): Promise<{ blocked: boolean; resetAt?: number } | undefined>; // resetAt — unix-секунди; undefined — перевірка не вдалась
}

// Клієнт OpenCode (сервер усередині контейнера): запити, форми (питання агента), стан і потік подій сесій. Id — сесії OpenCode.
export interface OpencodeClient {
	prompt(ocId: string, text: string, files?: PromptFile[]): Promise<void>;
	replyForm(ocId: string, formId: string, answer: FormAnswers): Promise<void>;
	cancelForm(ocId: string, formId: string, message?: string): Promise<void>;
	session(ocId: string): Promise<SessionInfo>;
	interrupt(ocId: string): Promise<void>;
	activeSessions(): Promise<string[]>;
	lastAssistant(ocId: string): Promise<{ text: string; error?: string }>;
	// Читає потік подій, поки він не закінчиться чи не спрацює signal; onEvent(undefined) — службовий рядок (heartbeat).
	events(signal: AbortSignal, onEvent: (event: OpencodeEvent | undefined) => Promise<void>): Promise<void>;
}

// Пост сесії в чаті: показ стану на місці, реакція, іконка й назва теми. Чат без бота нічого не робить (false / нічого).
export interface PostBoard {
	// Оновлює пост на місці. false — поста немає чи редагування не вдалось.
	show(id: string, w: WatchTarget, status: string, final?: boolean, answers?: PostAnswers, mergeable?: boolean, retry?: boolean): Promise<boolean>;
	// Правки поста йдуть у черзі: запізніла проміжна правка не має затирати підсумок.
	enqueue(edit: () => Promise<unknown>): Promise<unknown>;
	settled(): Promise<void>;
	// 👨‍💻 на пості, поки сесія працює.
	mark(w: WatchTarget, on: boolean): Promise<void>;
	icon(w: WatchTarget, state: TopicState): Promise<void>;
	rename(w: WatchTarget, title: string): Promise<boolean>;
}

// Чат, у якому живе пост сесії (низький рівень, без правил): редагування повідомлення, реакція, іконка й назва теми.
export interface PostChat {
	readonly enabled: boolean; // чи налаштовано бота
	edit(post: PostEdit): Promise<boolean>; // false — повідомлення видалили чи правка не вдалась
	react(chatId: number, postId: number, on: boolean): Promise<void>; // 👨‍💻 на пості
	setIcon(chatId: number, threadId: number, state: TopicState): Promise<void>;
	rename(chatId: number, threadId: number, title: string): Promise<boolean>;
}

// Що пам'ятаємо про пости: стан деплою й останній показаний стан (за id повідомлення) та пости, які пізніше оновлює вебхук GitHub.
export interface PostStore {
	deploy(postId: number): Promise<DeployInfo | undefined>;
	saveDeploy(postId: number, deploy: DeployInfo): Promise<void>;
	last(postId: number): Promise<LastShown | undefined>;
	saveLast(postId: number, last: LastShown): Promise<void>;
	saveRef(key: string, ref: PostRef): Promise<void>;
	takeRef(key: string): Promise<PostRef | undefined>; // забирається один раз
	forget(postId: number): Promise<void>; // сесію прибрано: забуваємо деплой і останній стан
}

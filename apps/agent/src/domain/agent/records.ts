import type { McpFlags } from "./mcp";
import type { DeployInfo, ImageRef, PostRef, StartInput, WatchTarget } from "./types";

// Записи, які агент тримає про сесії (у Durable Object, але ядро цього не знає: воно бачить лише порт SessionStore).

// Прийняте завдання (begin/resume), яке виконує alarm. target немає в запитів із веб-API: стеження й підсумок у чат їм ні до чого.
export type Job = { id: string; target?: WatchTarget; attempts: number; queuedAt?: number; startedAt?: number } & ({ input: StartInput } | { text: string; images?: ImageRef[] });

// За сесією стежать, щоб повідомити в чат про завершення. seenBusy: чи бачили ми її працюючою (щойно запущена сесія ще може
// не з'явитись серед активних, тому без цього «вільна» означало б «ще не почала»).
export type Watch = WatchTarget & { ocId: string; since: number; seenBusy: boolean };

// Сесія агента в спільному контейнері: id сесії (наш ключ ідемпотентності) → сесія OpenCode і репозиторій.
// folder: назва теки (і гілки agent/<folder>); у старих записів немає, тоді це сам id.
// post: пост сесії в чаті, який агент оновлює на місці (стан, підсумок).
export type Tracked = { ocId: string; repo?: string; folder?: string; model?: string; post?: { postId: number; header: string; chatId?: number; url?: string; threadId?: number; title?: string } } & McpFlags;

// Сесія впала на лімітах Claude: чекаємо їх скидання, щоб написати в чат (лише для тих, хто справді впертися в ліміт).
export type LimitWait = WatchTarget & { since: number };

// Модель OpenCode: провайдер і id.
export type ModelRef = { providerID: string; id: string };

// Зображення як вкладення до запиту (uri — data:-посилання): модель бачить їх як фото.
export type PromptFile = { uri: string; name: string };

// Сесія OpenCode з лічильниками: вартість, токени й чим закінчилась остання робота (outcome з'являється після першої).
export type SessionInfo = {
	cost?: number;
	tokens?: { input?: number; output?: number; reasoning?: number };
	outcome?: "succeeded" | "failed" | "interrupted";
	time?: { idle?: number };
};

// Подія сервера OpenCode (SSE `/api/event`): тип і, якщо стосується сесії, її id. Форма — питання агента.
export type FormField = { key?: string; type?: string; hidden?: boolean; title?: string; description?: string; maxItems?: number; options?: { value?: string; label?: string; description?: string }[] };
export type OpencodeForm = { id?: string; sessionID?: string; title?: string; fields?: FormField[] };
export type OpencodeEvent = { type: string; data?: { sessionID?: string; id?: string; name?: string; input?: Record<string, unknown>; form?: OpencodeForm } };

// Відповіді на форму: ключ поля → значення.
export type FormAnswers = Record<string, string | boolean | string[]>;

// Кнопки-відповіді під постом: підписи й чи можна вибрати кілька.
export type PostAnswers = { labels: string[]; multiple?: boolean };

// Іконка теми за станом сесії.
export type TopicState = "working" | "question" | "done" | "failed" | "approval" | "deploying" | "deployed" | "deployFailed";

// Варіант відповіді на питання агента: підпис на кнопці й значення, яке піде агентові.
export type Choice = { label: string; value: string | boolean | string[] };

// Питання агента, на яке можна відповісти кнопкою: форма й варіанти (callback_data несе лише номер варіанта).
// next — наступні кроки багатокрокової форми, answers — уже зібрані відповіді.
export type PendingForm = { askedAt?: number; formId: string; ocId: string; key: string; choices: Choice[]; multiple?: boolean; selected: number[]; text: string; next?: { key: string; choices: Choice[]; multiple?: boolean; text: string }[]; answers?: FormAnswers };

// Кнопки під постом сесії: поки працює — «Стоп»; після — «Повторити» (ліміти), «Змерджити» (є PR, деплою ще немає) чи лише «Видалити».
export type PostButtons = "working" | "done" | "mergeable" | "dismiss" | "retry";

// Запит на схвалення деплою в пості: репозиторій і запуск, для яких показуються «Схвалити/Відхилити».
export type PostReview = { repo: string; runId: number };

// Останній показаний у пості стан, щоб вебхук GitHub міг перемалювати пост з деплоєм.
export type LastShown = { status: string; final: boolean; mergeable: boolean };

// Редагування поста сесії в чаті: текст, кнопки й посилання на сесію (для кнопок і підпису).
export type PostEdit = { chatId: number; postId: number; text: string; session?: { id: string; url: string }; buttons: PostButtons; answers?: PostAnswers; review?: PostReview };

export type { DeployInfo, PostRef };

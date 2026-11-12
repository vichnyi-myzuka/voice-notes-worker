// Порт агента: сесія з автономним агентом, якій можна поставити задачу, дописати уточнення, спитати статус і яку можна зупинити.
// Реалізація — infrastructure/container (Durable Object + контейнер з OpenCode).

// name: коротка назва за змістом задачі (kebab-case); з неї складаються тека й гілка сесії, без неї — технічний id
export type StartInput = { prompt: string; repo?: string; name?: string };

// working — агент виконує задачу; idle — завершив або чекає на відповідь; stopped — контейнер не працює (заснув або зупинений).
export type AgentStatus = "working" | "idle" | "stopped";

export type SessionRef = { id: string; url: string };

// Докладний стан сесії для чату: статус плюс чим закінчилась остання робота й скільки вона коштувала.
// outcome з'являється, коли сесія вже щось виконала; без нього вільна сесія просто чекає на відповідь.
export type SessionReport = {
	status: AgentStatus;
	outcome?: "succeeded" | "failed" | "interrupted";
	cost?: number; // USD
	tokens?: number; // вхідні + вихідні + reasoning
};

// Куди повідомити про завершення роботи сесії (чат і посилання на неї).
// postId: пост сесії в чаті; поки сесія працює, на ньому стоїть 👨‍💻, після завершення реакцію знімає агент
// header: текст пост-шапки (завдання, репозиторій): агент оновлює пост на місці (шапка + стан/підсумок), тому потрібен його вміст;
// postId разом із header задається при першому спостереженні, далі пост сесії береться зі сховища
export type WatchTarget = { chatId: number; url: string; postId?: number; header?: string };

// Стан спільного контейнера для діагностики: що тримає його живим і коли був останній знімок.
export type ComputerInfo = {
	running: boolean;
	activeAt: number | null;
	alarmAt: number | null;
	snapshot: { id: string; at: number } | null;
	streams: { path: string; openedAt: number }[];
};

// Порт у контейнері: чи слухає і скільки встановлених з'єднань (SSH, OpenCode).
export type PortInfo = { listening: boolean; connections: number };

// Підключення до контейнера. Контейнер, що спить, не будиться: тоді лише running=false.
export type ConnectionsInfo = { running: boolean; ssh?: PortInfo; opencode?: PortInfo };

// Результат ручного знімка диска контейнера.
export type SnapshotInfo = { id: string; bytes: number; ms: number };

// Прибрана сесія і її пост у чаті (щоб прибрати й пост).
export type RemovedSession = { id: string; chatId?: number; postId?: number };

// Пост чату, який потім треба оновити (запит на схвалення деплою → його результат); живе у сховищі воркера.
export type PostRef = { chatId: number | string; messageId: number; text: string };

// Деплой PR сесії для її поста: text — рядки під станом сесії; repo+runId — чекає схвалення (кнопки); done — деплой завершено, сесію прибрано.
export type DeployInfo = { text: string; repo?: string; runId?: number; done?: boolean };

export type Agent = {
	// Показує деплой у пості сесії гілки agent/<folder>; false — сесії з постом немає. setDeployByPost: те саме за постом, лише якщо він уже показує деплой.
	setDeploy(repo: string, folder: string, deploy: DeployInfo): Promise<boolean>;
	setDeployByPost(postId: number, deploy: DeployInfo, force?: boolean): Promise<boolean>;
	// Запам'ятовує пост за ключем і віддає його один раз (take забирає): так результат деплою редагує пост зі схваленням.
	saveRef(key: string, ref: PostRef): Promise<void>;
	takeRef(key: string): Promise<PostRef | undefined>;
	// Адреса сесії в веб-інтерфейсі (від id, без звернення до контейнера): потрібна для посилання в пості до старту.
	url(id: string): string;
	// Приймає завдання й одразу повертається: холодний старт контейнера й клонування займають хвилини, а відповідь вебхуку
	// й waitUntil так довго не живуть. Запуск, стеження (target) і повтори ведe сам агент; збій він показує в пості (target.postId).
	begin(id: string, input: StartInput, target: WatchTarget): Promise<void>;
	// Те саме для уточнення в наявну сесію.
	resume(id: string, text: string, target: WatchTarget): Promise<void>;
	// Ідемпотентно за ключем: повторний виклик з тим самим id не створює другу сесію.
	start(id: string, input: StartInput): Promise<SessionRef>;
	// Кнопка під питанням агента: номер варіанта (одиночний вибір — це відповідь, множинний — перемикає варіант) чи "ok" (підтвердити
	// множинний вибір). Повертає текст підказки для користувача; undefined, якщо питання вже неактуальне.
	answer(id: string, choice: number | "ok"): Promise<string | undefined>;
	// Уточнення в ту саму сесію (голос чи текст після транскрипції).
	followUp(id: string, text: string): Promise<void>;
	status(id: string): Promise<AgentStatus>;
	// Докладніше за status: результат останньої роботи, вартість. Контейнер, що спить, не будить.
	report(id: string): Promise<SessionReport>;
	// Стежить за сесією: коли робота закінчиться (чи впаде, чи впреться в ліміт), надсилає підсумок у чат. Контейнер не будить.
	watch(id: string, target: WatchTarget): Promise<void>;
	// Перериває поточну роботу агента; сесія лишається, їй можна дописати далі.
	abort(id: string): Promise<void>;
	// Видаляє сесію: історію в OpenCode і теку (worktree) в контейнері; гілка agent/<назва> з комітами лишається в клоні
	remove(id: string): Promise<void>;
	// Прибирає сесію, чия гілка agent/<folder> у репозиторії repo змерджена (PR у main). undefined, якщо такої сесії немає.
	removeByBranch(repo: string, folder: string): Promise<RemovedSession | undefined>;
	// Репозиторій і гілка сесії (agent/<тека>), щоб знайти її PR; undefined, якщо сесія без репозиторію чи невідома.
	pullTarget(id: string): Promise<{ repo: string; branch: string } | undefined>;
	// Веб-інтерфейс: проксі запиту в спільний контейнер (усі сесії в одному інтерфейсі).
	serve(req: Request): Promise<Response>;
	// Id сесії в OpenCode для прямого посилання на сесію; undefined, якщо такої сесії немає.
	link(id: string): Promise<string | undefined>;
	// Внутрішній стан контейнера для діагностики (наприклад, чому він не засинає).
	info(): Promise<ComputerInfo>;
	// Чи працює контейнер; з detail ще й скільки SSH-з'єднань (і з'єднань воркера з OpenCode) відкрито. Контейнер не будить, але
	// detail читає /proc через exec, а exec продовжує життя контейнера (перевірено): не опитуй у циклі.
	connections(detail: boolean): Promise<ConnectionsInfo>;
	// Примусово зберігає диск контейнера (зміни, зроблені поза сесіями агента, наприклад через SSH).
	snapshot(): Promise<SnapshotInfo>;
	// Викидає збережений знімок і зупиняє контейнер: наступний старт іде з чистого образу (сесії й клони зникають)
	// unlessBusy: не чіпати, поки хтось працює. Повертає true, якщо скинуто
	resetComputer(unlessBusy?: boolean): Promise<boolean>;
};

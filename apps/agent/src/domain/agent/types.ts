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

export type Agent = {
	// Ідемпотентно за ключем: повторний виклик з тим самим id не створює другу сесію.
	start(id: string, input: StartInput): Promise<SessionRef>;
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
	resetComputer(): Promise<void>;
};

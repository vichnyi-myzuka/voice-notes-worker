// Порт агента: сесія з автономним агентом, якій можна поставити задачу, дописати уточнення, спитати статус і яку можна зупинити.
// Реалізація — infrastructure/container (Durable Object + контейнер з OpenCode).

export type StartInput = { prompt: string; repo?: string };

// working — агент виконує задачу; idle — завершив або чекає на відповідь; stopped — контейнер не працює (заснув або зупинений).
export type AgentStatus = "working" | "idle" | "stopped";

export type SessionRef = { id: string; url: string };

// Результат ручного знімка диска контейнера.
export type SnapshotInfo = { id: string; bytes: number; ms: number };

export type Agent = {
	// Ідемпотентно за ключем: повторний виклик з тим самим id не створює другу сесію.
	start(id: string, input: StartInput): Promise<SessionRef>;
	// Уточнення в ту саму сесію (голос чи текст після транскрипції).
	followUp(id: string, text: string): Promise<void>;
	status(id: string): Promise<AgentStatus>;
	// Перериває поточну роботу агента; сесія лишається, їй можна дописати далі.
	abort(id: string): Promise<void>;
	// Веб-інтерфейс: проксі запиту в спільний контейнер (усі сесії в одному інтерфейсі).
	serve(req: Request): Promise<Response>;
	// Id сесії в OpenCode для прямого посилання на сесію; undefined, якщо такої сесії немає.
	link(id: string): Promise<string | undefined>;
	// Примусово зберігає диск контейнера (зміни, зроблені поза сесіями агента, наприклад через SSH).
	snapshot(): Promise<SnapshotInfo>;
};

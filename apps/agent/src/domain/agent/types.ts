// Порт агента: сесія з автономним агентом, якій можна поставити задачу, дописати уточнення, спитати статус і яку можна зупинити.
// Реалізація — infrastructure/container (Durable Object + контейнер з OpenCode).

export type StartInput = { prompt: string; repo?: string };

// working — агент виконує задачу; idle — завершив або чекає на відповідь; stopped — контейнер не працює (заснув або зупинений).
export type AgentStatus = "working" | "idle" | "stopped";

export type SessionRef = { id: string; url: string };

export type Agent = {
	// Ідемпотентно за ключем: повторний виклик з тим самим id не створює другу сесію.
	start(id: string, input: StartInput): Promise<SessionRef>;
	// Уточнення в ту саму сесію (голос чи текст після транскрипції).
	followUp(id: string, text: string): Promise<void>;
	status(id: string): Promise<AgentStatus>;
	// Перериває поточну роботу агента; сесія лишається, їй можна дописати далі.
	abort(id: string): Promise<void>;
	// Веб-інтерфейс сесії: проксі запиту в контейнер.
	serve(id: string, req: Request): Promise<Response>;
};

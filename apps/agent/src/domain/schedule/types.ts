// Автоматизації агента (ADR 0005): запис розкладу, його запуски й порт, який реалізує Durable Object Scheduler.

// Коли запускати: один раз у момент `at` (мс) або за cron у часовому поясі tz (IANA).
export type When = { at: number } | { cron: string; tz: string };

// pending — чекає підтвердження власника (розклад створив агент); active — працює; paused — на паузі; done — одноразовий відпрацював чи минув термін.
export type ScheduleStatus = "pending" | "active" | "paused" | "done";

// ok — сесію запущено (як вона закінчилась, видно в самій сесії); failed — запустити не вдалося; skipped — попередній запуск ще працював.
export type Run = { at: number; result: "ok" | "failed" | "skipped"; sessionId?: string; error?: string };
// skipped з error: пропущено через добовий бюджет; без error — попередній запуск ще працював.

export type Schedule = {
	id: string;
	name: string;
	prompt: string;
	when: When;
	repo?: string;
	model?: string;
	// Власний ліміт вартості одного запуску (USD); без нього діє загальний AGENT_MAX_COST_USD.
	maxCostUsd?: number;
	status: ScheduleStatus;
	createdBy: "agent" | "owner";
	createdAt: number;
	expiresAt?: number;
	// Адреса воркера, з якої створено розклад: з неї складається посилання на сесію запуску.
	origin: string;
	nextRun?: number;
	// Останні запуски, найновіші в кінці.
	runs: Run[];
};

// Що приймає створення розкладу (час — ISO-рядок: так зручно агентові й формі).
export type NewSchedule = { name: string; prompt: string; at?: string; cron?: string; tz?: string; repo?: string; model?: string; maxCostUsd?: number; expiresAt?: string };
// maxCostUsd: 0 (чи відсутнє) — без власного ліміту.
export type SchedulePatch = Partial<NewSchedule>;

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; code: "invalid" | "limit" | "not_found" };

export type Schedules = {
	list(): Promise<Schedule[]>;
	get(id: string): Promise<Schedule | undefined>;
	create(input: NewSchedule, createdBy: Schedule["createdBy"], origin: string): Promise<Outcome<Schedule>>;
	// Змінює поля розкладу; зміна часу перераховує наступний запуск. Зміна від агента повертає розклад на підтвердження (pending).
	update(id: string, patch: SchedulePatch, by?: Schedule["createdBy"]): Promise<Outcome<Schedule>>;
	// pause: active → paused; resume: paused → active, а також pending → active (підтвердження власником).
	pause(id: string): Promise<Outcome<Schedule>>;
	resume(id: string): Promise<Outcome<Schedule>>;
	// Запускає зараз, не чіпаючи розкладу.
	runNow(id: string): Promise<Outcome<Run>>;
	remove(id: string): Promise<boolean>;
};

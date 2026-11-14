import { MAX_ACTIVE, MIN_INTERVAL_MS, nextRun, validate, type NewSchedule, type Outcome, type Run, type Schedule, type SchedulePatch, type Schedules } from "../../domain/schedule";

// Усе, що книга розкладів бере ззовні: сховище, alarm, запуск сесії, перевірка «ще працює» і повідомлення власнику.
export type Storage = {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<unknown>;
	list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};
export type Alarm = { set(at: number): Promise<void>; clear(): Promise<void> };
export type Launcher = {
	// Запускає сесію агента з id sessionId (ідемпотентно за id).
	launch(schedule: Schedule, sessionId: string): Promise<void>;
	running(sessionId: string): Promise<boolean>;
	// Показує власнику розклад, який запропонував агент, з кнопками «Активувати/Відхилити».
	propose(schedule: Schedule): Promise<void>;
	notify(text: string): Promise<void>;
};

const PREFIX = "schedule:";
const MAX_RUNS = 50;

// Id сесії запуску: з id розкладу й запланованого часу, тож повтор alarm не створює другу сесію. Починається з `tg-`, як усі сесії чату.
export const runSessionId = (scheduleId: string, at: number) => `tg-sch-${scheduleId}-${at.toString(36)}`;

const fail = (code: "invalid" | "limit" | "not_found", error: string): Outcome<never> => ({ ok: false, code, error });
const gone = fail("not_found", "no such schedule");

// Розклади в сховищі й запуск за alarm. Один alarm — на найближчий запуск серед активних.
export class ScheduleBook implements Schedules {
	constructor(
		private readonly store: Storage,
		private readonly alarm: Alarm,
		private readonly launcher: Launcher,
		private readonly now: () => number = Date.now,
	) {}

	async list(): Promise<Schedule[]> {
		const all = await this.store.list<Schedule>({ prefix: PREFIX });
		return [...all.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string) {
		return this.store.get<Schedule>(PREFIX + id);
	}

	async create(input: NewSchedule, createdBy: Schedule["createdBy"], origin: string): Promise<Outcome<Schedule>> {
		const now = this.now();
		const valid = validate(input, now);
		if (!valid.ok) return valid;
		// Агент лише пропонує: розклад чекає підтвердження власника.
		const status = createdBy === "agent" ? "pending" : "active";
		if ((await this.occupied()) >= MAX_ACTIVE) return fail("limit", `at most ${MAX_ACTIVE} active schedules`);
		const schedule: Schedule = { id: crypto.randomUUID().replaceAll("-", "").slice(0, 8), ...valid.value, status, createdBy, createdAt: now, origin, runs: [] };
		schedule.nextRun = nextRun(schedule.when, now);
		await this.save(schedule);
		if (status === "pending") await this.propose(schedule);
		return { ok: true, value: schedule };
	}

	async update(id: string, patch: SchedulePatch, by: Schedule["createdBy"] = "owner"): Promise<Outcome<Schedule>> {
		const current = await this.get(id);
		if (!current) return gone;
		const now = this.now();
		// Невказані поля беруться з поточного розкладу; час змінюють `at` або `cron` (tz можна змінити окремо, лише для cron).
		const timing = patch.at !== undefined || patch.cron !== undefined || patch.tz !== undefined;
		const cron = "cron" in current.when ? current.when : undefined;
		const expiresAt = patch.expiresAt ?? (current.expiresAt === undefined ? undefined : new Date(current.expiresAt).toISOString());
		const fields = { name: patch.name ?? current.name, prompt: patch.prompt ?? current.prompt, repo: patch.repo ?? current.repo, model: patch.model ?? current.model, expiresAt };
		// Без зміни часу час не перевіряємо: підставляємо завідомо майбутній `at` (минулий одноразовий розклад теж можна перейменувати).
		const probe: NewSchedule = !timing ? { ...fields, at: new Date(now + MIN_INTERVAL_MS).toISOString() } : patch.at === undefined && patch.cron === undefined && cron ? { ...fields, cron: cron.cron, tz: patch.tz } : { ...fields, at: patch.at, cron: patch.cron, tz: patch.tz ?? (patch.cron !== undefined ? cron?.tz : undefined) };
		const valid = validate(probe, now);
		if (!valid.ok) return valid;
		const { when, repo, model, expiresAt: expires, ...rest } = valid.value;
		const updated: Schedule = { ...current, ...rest, when: timing ? when : current.when, repo, model, expiresAt: expires };
		if (updated.status === "done" && timing) updated.status = "paused"; // новий час: власник сам вирішує, чи вмикати
		updated.nextRun = nextRun(updated.when, now);
		// Агент лише пропонує зміни: розклад чекає, поки власник їх підтвердить.
		const proposed = by === "agent" && (updated.status === "active" || updated.status === "paused" || updated.status === "done");
		if (proposed) updated.status = "pending";
		await this.save(updated);
		if (proposed) await this.propose(updated);
		return { ok: true, value: updated };
	}

	async pause(id: string): Promise<Outcome<Schedule>> {
		const s = await this.get(id);
		if (!s) return gone;
		if (s.status !== "active") return fail("invalid", `cannot pause a ${s.status} schedule`);
		return this.setStatus(s, "paused");
	}

	async resume(id: string): Promise<Outcome<Schedule>> {
		const s = await this.get(id);
		if (!s) return gone;
		if (s.status !== "paused" && s.status !== "pending") return fail("invalid", `cannot resume a ${s.status} schedule`);
		if ((await this.occupied(id)) >= MAX_ACTIVE) return fail("limit", `at most ${MAX_ACTIVE} active schedules`);
		const next = nextRun(s.when, this.now());
		if (next === undefined) return fail("invalid", "no upcoming run: change the time first");
		return this.setStatus({ ...s, nextRun: next }, "active");
	}

	async runNow(id: string): Promise<Outcome<Run>> {
		const s = await this.get(id);
		if (!s) return gone;
		const run = await this.fire(s, this.now());
		await this.save(this.record(s, run));
		return { ok: true, value: run };
	}

	async remove(id: string): Promise<boolean> {
		if (!(await this.get(id))) return false;
		await this.store.delete(PREFIX + id);
		await this.rearm();
		return true;
	}

	// Alarm: запускає всі розклади, час яких настав, і ставить наступний alarm.
	async tick(): Promise<void> {
		const now = this.now();
		for (const s of await this.list()) {
			if (s.status !== "active" || s.nextRun === undefined || s.nextRun > now) continue;
			if (s.expiresAt !== undefined && s.expiresAt <= now) {
				await this.save({ ...s, status: "done", nextRun: undefined });
				continue;
			}
			const run = await this.fire(s, s.nextRun);
			const next = nextRun(s.when, now);
			const expired = next !== undefined && s.expiresAt !== undefined && next >= s.expiresAt;
			await this.save({ ...this.record(s, run), nextRun: expired ? undefined : next, status: next === undefined || expired ? "done" : "active" });
		}
		await this.rearm();
	}

	// Запуск за розкладом. Збій і пропуск не кидають: їх бачить власник (повідомлення) й історія.
	private async fire(s: Schedule, at: number): Promise<Run> {
		const previous = [...s.runs].reverse().find((r) => r.sessionId);
		if (previous?.sessionId && (await this.launcher.running(previous.sessionId).catch(() => false))) {
			await this.launcher.notify(`⏰ «${s.name}»: попередній запуск ще працює, цей пропущено.`).catch(() => {});
			return { at, result: "skipped" };
		}
		const sessionId = runSessionId(s.id, at);
		try {
			await this.launcher.launch(s, sessionId);
			return { at, result: "ok", sessionId };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			console.error(`schedule ${s.id}: launch failed:`, err);
			await this.launcher.notify(`⏰ «${s.name}»: не вдалося запустити: ${error}`).catch(() => {});
			return { at, result: "failed", error };
		}
	}

	private record(s: Schedule, run: Run): Schedule {
		return { ...s, runs: [...s.runs, run].slice(-MAX_RUNS) };
	}

	// Збій показу не скасовує розклад: він лишається pending, власник побачить його в /api/schedules.
	private propose(s: Schedule): Promise<void> {
		return this.launcher.propose(s).catch((err) => console.error(`schedule ${s.id}: propose failed:`, err));
	}

	// Скільки місць займають розклади, що рахуються в ліміті (активні й ті, що чекають підтвердження).
	private async occupied(except?: string) {
		return (await this.list()).filter((s) => s.id !== except && (s.status === "active" || s.status === "pending")).length;
	}

	private setStatus(s: Schedule, status: Schedule["status"]): Promise<Outcome<Schedule>> {
		return this.save({ ...s, status }).then(() => ({ ok: true as const, value: { ...s, status } }));
	}

	private async save(s: Schedule): Promise<void> {
		for (const k of ["nextRun", "repo", "model", "expiresAt"] as const) if (s[k] === undefined) delete s[k];
		await this.store.put(PREFIX + s.id, s);
		await this.rearm();
	}

	// Alarm — на найближчий запуск серед активних; немає таких — alarm знімається.
	async rearm(): Promise<void> {
		const times = (await this.list()).flatMap((s) => (s.status === "active" && s.nextRun !== undefined ? [s.nextRun] : []));
		if (times.length) await this.alarm.set(Math.min(...times));
		else await this.alarm.clear();
	}
}

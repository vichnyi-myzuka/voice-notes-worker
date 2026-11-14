// Розклади автоматизацій агента: Durable Object Scheduler (ADR 0005).
import type { Schedules } from "../../domain/schedule";

export { Scheduler } from "./scheduler";

// Один Durable Object на весь розклад, як і контейнер.
export const SCHEDULER = "main";

export const durableSchedules = (ns: { getByName(name: string): Schedules }): Schedules => {
	const book = () => ns.getByName(SCHEDULER);
	return {
		list: () => book().list(),
		get: (id) => book().get(id),
		create: (input, createdBy, origin) => book().create(input, createdBy, origin),
		update: (id, patch) => book().update(id, patch),
		pause: (id) => book().pause(id),
		resume: (id) => book().resume(id),
		runNow: (id) => book().runNow(id),
		remove: (id) => book().remove(id),
	};
};

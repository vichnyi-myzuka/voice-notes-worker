// Мінімальний cron: 5 полів (хвилина година день місяць день-тижня), `*`, списки, діапазони, кроки (`*/15`, `1-5`, `1,3,5`).
// День-тижня 0-7 (0 і 7 — неділя). Як у класичного cron, коли обмежені і день місяця, і день тижня, підходить будь-який із них.
// Час рахується в часовому поясі розкладу (IANA, напр. Europe/Kyiv).

type Field = { any: boolean; values: Set<number> };
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
] as const;

function parseField(raw: string, [min, max]: readonly [number, number]): Field {
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const [range, step, extra] = part.split("/");
		if (extra !== undefined || !range) throw new Error(`bad cron field "${raw}"`);
		const size = step === undefined ? 1 : Number(step);
		if (!Number.isInteger(size) || size < 1) throw new Error(`bad cron step "${part}"`);
		const [from, to] = range === "*" ? [min, max] : range.split("-").map(Number);
		const end = range === "*" || range.includes("-") ? to : step === undefined ? from : max;
		if (!Number.isInteger(from) || !Number.isInteger(end) || from < min || end > max || from > end) throw new Error(`bad cron value "${part}"`);
		for (let v = from; v <= end; v += size) values.add(v);
	}
	return { any: raw === "*", values };
}

export function parseCron(expr: string): Cron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("cron must have 5 fields: minute hour day month weekday");
	const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i]));
	if (dow.values.has(7)) dow.values.add(0);
	return { minute, hour, dom, month, dow };
}

const formats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Локальний час у поясі; RangeError, якщо пояс невідомий.
function local(t: number, tz: string) {
	let f = formats.get(tz);
	if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })));
	const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
	return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday) };
}

export const validTimezone = (tz: string) => {
	try {
		local(0, tz);
		return true;
	} catch {
		return false;
	}
};

const MAX_STEPS = 400_000;

// Найближчий запуск строго після `after` (мс), undefined, якщо найближчі ~5 років запусків немає (напр. 30 лютого).
export function nextCron(cron: Cron, tz: string, after: number): number | undefined {
	let t = (Math.floor(after / 60_000) + 1) * 60_000;
	for (let i = 0; i < MAX_STEPS; i++) {
		const p = local(t, tz);
		const dayOk = cron.dom.any && cron.dow.any ? true : cron.dom.any ? cron.dow.values.has(p.weekday) : cron.dow.any ? cron.dom.values.has(p.day) : cron.dom.values.has(p.day) || cron.dow.values.has(p.weekday);
		if (!cron.month.values.has(p.month) || !dayOk) {
			// До кінця доби, із запасом на перехід на літній час (останні дві години проходимо кроками по 30 хв).
			const left = 1440 - p.hour * 60 - p.minute;
			t += (left > 120 ? left - 60 : Math.min(left, 30)) * 60_000;
		} else if (!cron.hour.values.has(p.hour)) t += (60 - p.minute) * 60_000;
		else if (!cron.minute.values.has(p.minute)) t += 60_000;
		else return t;
		if (t - after > 5 * 366 * 86_400_000) return undefined;
	}
	return undefined;
}

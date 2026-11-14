import { nextCron, parseCron, validTimezone } from "./cron";
import type { NewSchedule, Outcome, When } from "./types";

// Запобіжники з ADR 0005 (значення орієнтовні).
export const MAX_ACTIVE = 10;
export const MIN_INTERVAL_MS = 3_600_000;
export const DEFAULT_TZ = "Europe/Kyiv";
const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

const bad = (error: string): Outcome<never> => ({ ok: false, error, code: "invalid" });

// Перевіряє введення й повертає розклад у внутрішньому вигляді (When, expiresAt у мс). `now` — для перевірки «у майбутньому».
export function validate(input: NewSchedule, now: number): Outcome<{ name: string; prompt: string; when: When; repo?: string; model?: string; expiresAt?: number }> {
	const name = input.name?.trim();
	const prompt = input.prompt?.trim();
	if (!name || name.length > 80) return bad("name is required (up to 80 chars)");
	if (!prompt) return bad("prompt is required");
	if (input.repo && !REPO.test(input.repo)) return bad("bad repo");
	if (!!input.at === !!input.cron) return bad("set exactly one of `at` or `cron`");
	let when: When;
	if (input.at) {
		const at = Date.parse(input.at);
		if (!Number.isFinite(at)) return bad("bad `at`: expected an ISO date-time with offset, e.g. 2026-12-01T09:00:00+02:00");
		if (at <= now) return bad("`at` must be in the future");
		when = { at };
	} else {
		const tz = input.tz ?? DEFAULT_TZ;
		if (!validTimezone(tz)) return bad(`unknown time zone "${tz}"`);
		try {
			const cron = parseCron(input.cron!);
			// Інтервал між найближчими запусками не менший за годину.
			let t: number | undefined = now;
			let prev: number | undefined;
			for (let i = 0; i < 8; i++) {
				t = nextCron(cron, tz, t);
				if (t === undefined) return i === 0 ? bad("cron never fires") : bad("cron fires too rarely to check");
				if (prev !== undefined && t - prev < MIN_INTERVAL_MS) return bad("minimum interval between runs is 1 hour");
				prev = t;
			}
		} catch (err) {
			return bad(err instanceof Error ? err.message : String(err));
		}
		when = { cron: input.cron!.trim(), tz };
	}
	let expiresAt: number | undefined;
	if (input.expiresAt) {
		expiresAt = Date.parse(input.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= now) return bad("`expiresAt` must be a future ISO date-time");
	}
	return { ok: true, value: { name, prompt, when, ...(input.repo && { repo: input.repo }), ...(input.model && { model: input.model }), ...(expiresAt && { expiresAt }) } };
}

// Наступний запуск після `after`: для одноразового — його час, поки він попереду.
export function nextRun(when: When, after: number): number | undefined {
	return "at" in when ? (when.at > after ? when.at : undefined) : nextCron(parseCron(when.cron), when.tz, after);
}

// Найближчі запуски для форми (ADR 0005): ті самі перевірки, що й при створенні, плюс `count` наступних моментів (мс).
export function preview(input: Pick<NewSchedule, "at" | "cron" | "tz">, now: number, count = 5): Outcome<number[]> {
	const valid = validate({ name: "preview", prompt: "preview", ...input }, now);
	if (!valid.ok) return valid;
	const times: number[] = [];
	for (let t = nextRun(valid.value.when, now); t !== undefined && times.length < count; t = nextRun(valid.value.when, t)) times.push(t);
	return { ok: true, value: times };
}

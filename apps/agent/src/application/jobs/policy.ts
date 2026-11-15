// Скільки й як довго агент повторює, чекає й що пише в пості.
export const WORKING = "⏳ Працює";
export const LIMIT_POLL_MS = 5 * 60 * 1000; // як часто перевіряти, чи скинулись ліміти Claude
export const JOB_ATTEMPTS = 6; // спроб запустити прийняте завдання, перш ніж повідомити про збій
export const JOB_RETRY_MS = 15 * 1000; // пауза між спробами
export const JOB_STALE_MS = 3 * 60 * 1000; // завдання з startedAt вважається виконуваним, доки не мине цей час (страховка від вивантаження)

// Чи схожа помилка моделі на вичерпані ліміти підписки (а не на збій завдання).
export function isLimitError(error: string): boolean {
	return /usage limit|hit your (?:[\w-]+ )*limit|limit reached|rate[ _-]?limit|\b429\b|exceeded.*(quota|limit)/i.test(error);
}

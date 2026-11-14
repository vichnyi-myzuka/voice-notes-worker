// Вимірювання затримок для Workers Logs: один рядок `latency <що>: етап=NNNms … total=NNNms`, який легко шукати за словом
// «latency». Без тексту повідомлень і іншого приватного: лише назви етапів, мілісекунди й службові поля.
export type Stopwatch = {
	// Фіксує етап: скільки минуло від попереднього етапу (чи від початку).
	mark(stage: string): void;
	// Виводить рядок із усіма етапами й загальним часом; fields — службові поля (kind=voice, cold=true…).
	log(fields?: Record<string, string | number | boolean | undefined>): void;
};

// Мітка часу для логів (UTC, мілісекунди): за нею рядки з різних воркерів і Durable Object зіставляються між собою.
export const stamp = (ms: number = Date.now()): string => new Date(ms).toISOString();

export function stopwatch(what: string, now: () => number = Date.now): Stopwatch {
	const start = now();
	let last = start;
	const stages: string[] = [];
	return {
		mark(stage) {
			const t = now();
			stages.push(`${stage}=${t - last}ms`);
			last = t;
		},
		log(fields = {}) {
			const extra = Object.entries(fields).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`]));
			console.log(`latency ${what}: ${[`start=${stamp(start)}`, ...extra, ...stages, `end=${stamp(now())}`, `total=${now() - start}ms`].join(" ")}`);
		},
	};
}

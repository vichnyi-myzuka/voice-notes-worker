import type { Env, Job } from "./infrastructure/env";
import { telegramChannel, workersLlm } from "@voice-notes/core";
import { r2Ledger, r2Notes } from "./infrastructure/r2";
import { todoistTracker } from "./infrastructure/todoist";
import { handleFetch } from "./interface/inbox";
import { handleQueue } from "./interface/queue";

export type { Env } from "./infrastructure/env";

// Складання: канал (зараз Telegram), трекер задач (Todoist), сховище (R2) і моделі (OpenAI / Workers AI) передаються в інтерфейси.
const ports = (env: Env) => {
	const llm = workersLlm(env);
	return { channel: telegramChannel(env), tracker: todoistTracker(env, llm), notes: r2Notes(env), ledger: r2Ledger(env), llm };
};

export default {
	fetch: (req, env) => handleFetch(req, env, ports(env)),
	queue: (batch, env) => handleQueue(batch, env, ports(env)),
} satisfies ExportedHandler<Env, Job>;

import type { Env, Job } from "./infrastructure/env";
import { telegramChannel } from "./infrastructure/telegram";
import { todoistTracker } from "./infrastructure/todoist";
import { handleFetch } from "./interface/inbox";
import { handleQueue } from "./interface/queue";

export type { Env } from "./infrastructure/env";

// Складання: канал (зараз Telegram) і трекер задач (зараз Todoist) передаються в інтерфейси.
export default {
	fetch: (req, env) => handleFetch(req, env, telegramChannel(env)),
	queue: (batch, env) => handleQueue(batch, env, { channel: telegramChannel(env), tracker: todoistTracker(env) }),
} satisfies ExportedHandler<Env, Job>;

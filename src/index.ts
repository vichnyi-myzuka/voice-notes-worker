import type { Env, Job } from "./infrastructure/env";
import { telegramChannel } from "./infrastructure/telegram";
import { handleFetch } from "./interface/inbox";
import { handleQueue } from "./interface/queue";

export type { Env } from "./infrastructure/env";

// Складання: канал (зараз Telegram) передається в інтерфейси.
export default {
	fetch: (req, env) => handleFetch(req, env, telegramChannel(env)),
	queue: (batch, env) => handleQueue(batch, env, telegramChannel(env)),
} satisfies ExportedHandler<Env, Job>;

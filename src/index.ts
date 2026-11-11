import type { Env, Job } from "./infrastructure/env";
import { handleFetch } from "./interface/inbox";
import { handleQueue } from "./interface/queue";

export type { Env } from "./infrastructure/env";

export default { fetch: handleFetch, queue: handleQueue } satisfies ExportedHandler<Env, Job>;

import type { Env, Job } from "./env";
import { handleFetch } from "./inbox";
import { handleQueue } from "./queue";

export type { Env } from "./env";

export default { fetch: handleFetch, queue: handleQueue } satisfies ExportedHandler<Env, Job>;

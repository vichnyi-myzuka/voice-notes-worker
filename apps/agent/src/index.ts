import type { Env } from "./env";
import { handleFetch } from "./interface/http";

export { AgentSession } from "./infrastructure/container";
export type { Env } from "./env";

export default {
	fetch: (req, env) => handleFetch(req, env),
} satisfies ExportedHandler<Env>;

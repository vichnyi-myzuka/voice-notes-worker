import type { Env } from "./env";
import { durableAgent } from "./infrastructure/container";
import { handleFetch } from "./interface/http";

export { AgentSession } from "./infrastructure/container";
export type { Env } from "./env";

export default {
	fetch: (req, env) => handleFetch(req, env, durableAgent(env.AGENT_SESSION, new URL(req.url).origin)),
} satisfies ExportedHandler<Env>;

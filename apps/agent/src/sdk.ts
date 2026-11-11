import type { Env } from "./env";
import { durableAgent } from "./infrastructure/container/agent";
import type { WorkerdSession } from "./infrastructure/workerd";
import { handleFetch } from "./interface/http";

export { WorkerdSession } from "./infrastructure/workerd";

type SdkEnv = Omit<Env, "AGENT_SESSION"> & { AGENT_SESSION: DurableObjectNamespace<WorkerdSession> };

// Другий вхід воркера агента: той самий HTTP-шар і порт Agent, але сесія працює на OpenCode SDK у Durable Object (див. wrangler.sdk.toml).
export default {
	fetch: (req, env) => handleFetch(req, env as unknown as Env, durableAgent(env.AGENT_SESSION, new URL(req.url).origin)),
} satisfies ExportedHandler<SdkEnv>;

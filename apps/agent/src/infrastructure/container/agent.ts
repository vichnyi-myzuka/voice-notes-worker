import type { Agent } from "../../domain/agent";
import type { Env } from "../../env";

// Адаптер порту Agent: сесія = Durable Object з іменем id.
export const durableAgent = (env: Pick<Env, "AGENT_SESSION">, origin: string): Agent => {
	const session = (id: string) => env.AGENT_SESSION.getByName(id);
	return {
		async start(id, input) {
			await session(id).start(input);
			return { id, url: `${origin}/s/${id}` };
		},
		followUp: (id, text) => session(id).followUp(text),
		status: (id) => session(id).status(),
		abort: (id) => session(id).abort(),
		serve: (id, req) => session(id).fetch(req),
	};
};

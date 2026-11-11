import type { Agent, AgentStatus, StartInput } from "../../domain/agent";

// Що має вміти Durable Object сесії, щоб за ним працював порт Agent (контейнерний AgentSession або WorkerdSession на SDK).
export type SessionObject = {
	start(input: StartInput): Promise<unknown>;
	followUp(text: string): Promise<void>;
	status(): Promise<AgentStatus>;
	abort(): Promise<void>;
	fetch(req: Request): Promise<Response>;
};

// Адаптер порту Agent: сесія = Durable Object з іменем id.
export const durableAgent = (ns: { getByName(name: string): SessionObject }, origin: string): Agent => {
	const session = (id: string) => ns.getByName(id);
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

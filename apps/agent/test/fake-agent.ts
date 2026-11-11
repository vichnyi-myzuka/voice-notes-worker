import type { Agent, AgentStatus, StartInput } from "../src/domain/agent";

// Агент у пам'яті: те саме, що робить Durable Object з контейнером, але без контейнера й мережі.
// Поведінка як у реальної реалізації: start ідемпотентний за id, abort повертає сесію у idle,
// followUp будить сесію (working), а для невідомої сесії будь-яка дія — помилка.
export type FakeSession = { input: StartInput; messages: string[]; status: AgentStatus };

export function fakeAgent(origin = "https://agent.example") {
	const sessions = new Map<string, FakeSession>();
	const served: string[] = [];
	const get = (id: string) => {
		const s = sessions.get(id);
		if (!s) throw new Error(`unknown session ${id}`);
		return s;
	};
	const agent: Agent = {
		async start(id, input) {
			if (!sessions.has(id)) sessions.set(id, { input, messages: [input.prompt], status: "working" });
			return { id, url: `${origin}/s/${id}` };
		},
		async followUp(id, text) {
			const s = get(id);
			s.messages.push(text);
			s.status = "working";
		},
		async status(id) {
			return sessions.get(id)?.status ?? "stopped";
		},
		async abort(id) {
			get(id).status = "idle";
		},
		async serve(id) {
			served.push(id);
			return new Response(`ui:${id}`);
		},
	};
	return { agent, sessions, served };
}

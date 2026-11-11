import type { Agent, AgentStatus, ComputerInfo, SnapshotInfo, StartInput } from "../../domain/agent";

// Що має вміти Durable Object, щоб за ним працював порт Agent: він володіє єдиним контейнером і всіма сесіями в ньому.
export type SessionObject = {
	start(id: string, input: StartInput): Promise<unknown>;
	followUp(id: string, text: string): Promise<void>;
	status(id: string): Promise<AgentStatus>;
	abort(id: string): Promise<void>;
	link(id: string): Promise<string | undefined>;
	snapshot(): Promise<SnapshotInfo>;
	info(): Promise<ComputerInfo>;
	fetch(req: Request): Promise<Response>;
};

// Усі сесії живуть в одному контейнері, яким володіє один Durable Object.
export const COMPUTER = "main";

// Адаптер порту Agent: один Durable Object на всі сесії, id сесії лише ключ усередині нього.
export const durableAgent = (ns: { getByName(name: string): SessionObject }, origin: string): Agent => {
	const computer = () => ns.getByName(COMPUTER);
	return {
		async start(id, input) {
			await computer().start(id, input);
			return { id, url: `${origin}/s/${id}` };
		},
		followUp: (id, text) => computer().followUp(id, text),
		status: (id) => computer().status(id),
		abort: (id) => computer().abort(id),
		serve: (req) => computer().fetch(req),
		link: (id) => computer().link(id),
		snapshot: () => computer().snapshot(),
		info: () => computer().info(),
	};
};

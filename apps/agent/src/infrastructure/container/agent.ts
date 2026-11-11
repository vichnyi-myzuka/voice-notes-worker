import type { Agent, AgentStatus, ComputerInfo, ConnectionsInfo, SessionReport, SnapshotInfo, StartInput, WatchTarget } from "../../domain/agent";

// Що має вміти Durable Object, щоб за ним працював порт Agent: він володіє єдиним контейнером і всіма сесіями в ньому.
export type SessionObject = {
	start(id: string, input: StartInput): Promise<unknown>;
	followUp(id: string, text: string): Promise<void>;
	status(id: string): Promise<AgentStatus>;
	report(id: string): Promise<SessionReport>;
	watch(id: string, target: WatchTarget): Promise<void>;
	abort(id: string): Promise<void>;
	remove(id: string): Promise<void>;
	link(id: string): Promise<string | undefined>;
	snapshot(): Promise<SnapshotInfo>;
	resetComputer(): Promise<void>;
	info(): Promise<ComputerInfo>;
	connections(detail: boolean): Promise<ConnectionsInfo>;
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
		report: (id) => computer().report(id),
		watch: (id, target) => computer().watch(id, target),
		abort: (id) => computer().abort(id),
		remove: (id) => computer().remove(id),
		serve: (req) => computer().fetch(req),
		link: (id) => computer().link(id),
		snapshot: () => computer().snapshot(),
		resetComputer: () => computer().resetComputer(),
		info: () => computer().info(),
		connections: (detail) => computer().connections(detail),
	};
};

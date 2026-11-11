import type { Agent, AgentStatus, SessionReport, StartInput, WatchTarget } from "../src/domain/agent";

// Агент у пам'яті: те саме, що робить Durable Object з контейнером, але без контейнера й мережі.
// Поведінка як у реальної реалізації: start ідемпотентний за id, abort повертає сесію у idle,
// followUp будить сесію (working), а для невідомої сесії будь-яка дія — помилка. Веб-інтерфейс один на всі сесії.
export type FakeSession = { input: StartInput; messages: string[]; status: AgentStatus; outcome?: SessionReport["outcome"]; cost?: number };

export function fakeAgent(origin = "https://agent.example") {
	const sessions = new Map<string, FakeSession>();
	const served: string[] = [];
	const snapshots: string[] = [];
	const resets: string[] = [];
	const watches: { id: string; target: WatchTarget }[] = [];
	let snapshotError = "";
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
			s.outcome = undefined;
		},
		async status(id) {
			return sessions.get(id)?.status ?? "stopped";
		},
		async report(id) {
			const s = sessions.get(id);
			return s ? { status: s.status, outcome: s.outcome, cost: s.cost } : { status: "stopped" };
		},
		async watch(id, target) {
			get(id);
			watches.push({ id, target });
		},
		async abort(id) {
			const s = get(id);
			s.status = "idle";
			s.outcome = "interrupted";
		},
		async serve(req) {
			served.push(new URL(req.url).pathname);
			return new Response("ui");
		},
		async link(id) {
			return sessions.has(id) ? `ses_${id}` : undefined;
		},
		async connections() {
			return { running: true, ssh: { listening: true, connections: 1 }, opencode: { listening: true, connections: 2 } };
		},
		async info() {
			return { running: true, activeAt: 1, alarmAt: null, snapshot: null, streams: [] };
		},
		async resetComputer() {
			resets.push("reset");
		},
		async snapshot() {
			if (snapshotError) throw new Error(snapshotError);
			snapshots.push("snap");
			return { id: `snap${snapshots.length}`, bytes: 1, ms: 2 };
		},
	};
	return { agent, sessions, served, snapshots, resets, watches, failSnapshot: (message: string) => void (snapshotError = message) };
}

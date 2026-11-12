import type { Agent, DeployInfo, PostRef, AgentStatus, SessionReport, StartInput, WatchTarget } from "../src/domain/agent";

// Агент у пам'яті: те саме, що робить Durable Object з контейнером, але без контейнера й мережі.
// Поведінка як у реальної реалізації: start ідемпотентний за id, abort повертає сесію у idle,
// followUp будить сесію (working), а для невідомої сесії будь-яка дія — помилка. Веб-інтерфейс один на всі сесії.
export type FakeSession = { input: StartInput; messages: string[]; posted?: boolean; status: AgentStatus; outcome?: SessionReport["outcome"]; cost?: number };

const CHAT = -1001; // чат, у якому «живе» пост сесії

export function fakeAgent(origin = "https://agent.example") {
	const sessions = new Map<string, FakeSession>();
	const served: string[] = [];
	const snapshots: string[] = [];
	const resets: string[] = [];
	const watches: { id: string; target: WatchTarget }[] = [];
	const choices = new Map<string, string[]>(); // id сесії → підписи варіантів поточного питання (тест задає)
	const refs = new Map<string, PostRef>();
	const deploys: { repo?: string; folder?: string; postId?: number; deploy: DeployInfo }[] = [];
	const silpoCodes: string[] = [];
	let snapshotError = "";
	const get = (id: string) => {
		const s = sessions.get(id);
		if (!s) throw new Error(`unknown session ${id}`);
		return s;
	};
	const agent: Agent = {
		url: (id) => `${origin}/s/${id}`,
		async begin(id, input, target) {
			await agent.start(id, input);
			await agent.watch(id, target);
		},
		async answer(id, choice) {
			get(id);
			const label = typeof choice === "number" ? choices.get(id)?.[choice] : undefined;
			return label && `Відповідь: ${label}`;
		},
		async resume(id, text, target) {
			await agent.followUp(id, text);
			await agent.watch(id, target);
		},
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
		async setModel(id, model) {
			const s = get(id);
			if (model === "nope") return false;
			s.input = { ...s.input, model };
			return true;
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
		async remove(id) {
			sessions.delete(id);
		},
		async removeByBranch(repo, folder) {
			for (const [id, s] of sessions) {
				if (s.input.repo === repo && `${s.input.name}-${id.split("-").at(-1)}` === folder) {
					sessions.delete(id);
					return { id, chatId: CHAT, postId: 77 };
				}
			}
			return undefined;
		},
		async serve(req) {
			served.push(new URL(req.url).pathname);
			return new Response("ui");
		},
		async link(id) {
			return sessions.has(id) ? `ses_${id}` : undefined;
		},
		async setDeploy(repo, folder, deploy) {
			for (const [id, s] of sessions) {
				if (s.input.repo === repo && `${s.input.name}-${id.split("-").at(-1)}` === folder && s.posted) {
					deploys.push({ repo, folder, deploy });
					return true;
				}
			}
			return false;
		},
		async setDeployByPost(postId, deploy, _force) {
			deploys.push({ postId, deploy });
			return postId === 77;
		},
		async saveRef(key, ref) {
			refs.set(key, ref);
		},
		async takeRef(key) {
			const ref = refs.get(key);
			refs.delete(key);
			return ref;
		},
		async pullTarget(id) {
			const s = sessions.get(id);
			return s?.input.repo ? { repo: s.input.repo, branch: `agent/${s.input.name ?? id}-${id.split("-").at(-1)}` } : undefined;
		},
		async connections() {
			return { running: true, ssh: { listening: true, connections: 1 }, opencode: { listening: true, connections: 2 } };
		},
		async info() {
			return { running: true, activeAt: 1, alarmAt: null, snapshot: null, streams: [] };
		},
		async silpoLoginUrl(o) {
			return `https://mcp.silpo.example/authorize?redirect_uri=${o}/silpo/callback`;
		},
		async silpoCallback(code, state) {
			if (state !== "good") return false;
			silpoCodes.push(code);
			return true;
		},
		async silpoConnected() {
			return silpoCodes.length > 0;
		},
		async resetComputer(unlessBusy) {
			if (unlessBusy && [...sessions.values()].some((s) => s.status === "working")) return false;
			resets.push("reset");
			return true;
		},
		async snapshot() {
			if (snapshotError) throw new Error(snapshotError);
			snapshots.push("snap");
			return { id: `snap${snapshots.length}`, bytes: 1, ms: 2 };
		},
	};
	return { agent, deploys, choices, sessions, served, snapshots, resets, watches, failSnapshot: (message: string) => void (snapshotError = message) };
}

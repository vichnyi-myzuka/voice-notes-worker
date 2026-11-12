import type { Agent, DeployInfo, PostRef, AgentStatus, ComputerInfo, ConnectionsInfo, RemovedSession, SessionReport, SnapshotInfo, StartInput, WatchTarget } from "../../domain/agent";

// Що має вміти Durable Object, щоб за ним працював порт Agent: він володіє єдиним контейнером і всіма сесіями в ньому.
export type SessionObject = {
	start(id: string, input: StartInput): Promise<unknown>;
	begin(id: string, input: StartInput, target: WatchTarget): Promise<void>;
	resume(id: string, text: string, target: WatchTarget): Promise<void>;
	answer(id: string, choice: number | "ok"): Promise<string | undefined>;
	followUp(id: string, text: string): Promise<void>;
	setModel(id: string, model: string): Promise<boolean>;
	status(id: string): Promise<AgentStatus>;
	report(id: string): Promise<SessionReport>;
	watch(id: string, target: WatchTarget): Promise<void>;
	abort(id: string): Promise<void>;
	remove(id: string): Promise<void>;
	removeByBranch(repo: string, folder: string): Promise<RemovedSession | undefined>;
	link(id: string): Promise<string | undefined>;
	setDeploy(repo: string, folder: string, deploy: DeployInfo): Promise<boolean>;
	setDeployByPost(postId: number, deploy: DeployInfo, force?: boolean): Promise<boolean>;
	saveRef(key: string, ref: PostRef): Promise<void>;
	takeRef(key: string): Promise<PostRef | undefined>;
	pullTarget(id: string): Promise<{ repo: string; branch: string } | undefined>;
	snapshot(): Promise<SnapshotInfo>;
	resetComputer(unlessBusy?: boolean): Promise<boolean>;
	silpoLoginUrl(origin: string): Promise<string>;
	silpoCallback(code: string, state: string): Promise<boolean>;
	silpoConnected(): Promise<boolean>;
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
		url: (id) => `${origin}/s/${id}`,
		begin: (id, input, target) => computer().begin(id, input, target),
		resume: (id, text, target) => computer().resume(id, text, target),
		answer: (id, choice) => computer().answer(id, choice),
		async start(id, input) {
			await computer().start(id, input);
			return { id, url: `${origin}/s/${id}` };
		},
		followUp: (id, text) => computer().followUp(id, text),
		setModel: (id, model) => computer().setModel(id, model),
		status: (id) => computer().status(id),
		report: (id) => computer().report(id),
		watch: (id, target) => computer().watch(id, target),
		abort: (id) => computer().abort(id),
		remove: (id) => computer().remove(id),
		removeByBranch: (repo, folder) => computer().removeByBranch(repo, folder),
		serve: (req) => computer().fetch(req),
		link: (id) => computer().link(id),
		pullTarget: (id) => computer().pullTarget(id),
		setDeploy: (repo, folder, deploy) => computer().setDeploy(repo, folder, deploy),
		setDeployByPost: (postId, deploy, force) => computer().setDeployByPost(postId, deploy, force),
		saveRef: (key, ref) => computer().saveRef(key, ref),
		takeRef: (key) => computer().takeRef(key),
		snapshot: () => computer().snapshot(),
		resetComputer: (unlessBusy) => computer().resetComputer(unlessBusy),
		silpoLoginUrl: (origin) => computer().silpoLoginUrl(origin),
		silpoCallback: (code, state) => computer().silpoCallback(code, state),
		silpoConnected: () => computer().silpoConnected(),
		info: () => computer().info(),
		connections: (detail) => computer().connections(detail),
	};
};

import type { Job, LimitProbe, LimitWait, Notices, Scheduler, SessionStore, Tracked, Watch } from "../src/domain/agent";

// Фейки портів ядра агента: усе в пам'яті, без Durable Object, чату й мережі.
export function fakeStore(): SessionStore {
	const sessions = new Map<string, Tracked>();
	const watches = new Map<string, Watch>();
	const jobs = new Map<string, Job>();
	const limits = new Map<string, LimitWait>();
	return {
		session: async (id) => sessions.get(id),
		saveSession: async (id, t) => void sessions.set(id, t),
		dropSession: async (id) => sessions.delete(id),
		sessions: async () => [...sessions],
		sessionByOc: async (ocId) => [...sessions].find(([, t]) => t.ocId === ocId),
		sessionByBranch: async (repo, folder, anyRepo) => [...sessions].find(([id, t]) => (t.folder ?? id) === folder && (t.repo === repo || (anyRepo && !t.repo))),
		watch: async (id) => watches.get(id),
		saveWatch: async (id, w) => void watches.set(id, w),
		dropWatch: async (id) => watches.delete(id),
		watches: async () => [...watches],
		watchByOc: async (ocId) => [...watches].find(([, w]) => w.ocId === ocId),
		watching: async () => watches.size > 0,
		job: async (id) => jobs.get(id),
		saveJob: async (j) => void jobs.set(j.id, j),
		dropJob: async (id) => jobs.delete(id),
		jobs: async () => [...jobs.values()],
		limit: async (id) => limits.get(id),
		saveLimit: async (id, w) => void limits.set(id, w),
		dropLimit: async (id) => limits.delete(id),
		limits: async () => [...limits],
	};
}

export function fakeScheduler() {
	const calls = { now: 0, noLater: [] as number[] };
	const pending: Promise<unknown>[] = [];
	const scheduler: Scheduler = {
		now: async () => void calls.now++,
		noLater: async (at) => void calls.noLater.push(at),
		background: (work) => void pending.push(work),
	};
	return { scheduler, calls, settle: () => Promise.all(pending.splice(0)) };
}

export function fakeNotices(enabled = true) {
	const sent: { id: string; text: string; kind: string }[] = [];
	const shown: { id: string; text: string }[] = [];
	const notices: Notices = {
		enabled,
		show: async (id, _t, text) => (shown.push({ id, text }), false),
		send: async (id, _t, text, kind) => void sent.push({ id, text, kind }),
	};
	return { notices, sent, shown };
}

export const fakeProbe = (configured: boolean, state: { blocked: boolean; resetAt?: number } | undefined): LimitProbe => ({ configured, read: async () => state });

import type { FormAnswers, Job, LimitProbe, LimitWait, Notices, OpencodeClient, PendingForm, PostBoard, Scheduler, SessionStore, Tracked, Watch } from "../src/domain/agent";

// Фейки портів ядра агента: усе в пам'яті, без Durable Object, чату й мережі.
export function fakeStore(): SessionStore {
	const sessions = new Map<string, Tracked>();
	const watches = new Map<string, Watch>();
	const jobs = new Map<string, Job>();
	const limits = new Map<string, LimitWait>();
	const forms = new Map<string, PendingForm>();
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
		form: async (id) => forms.get(id),
		saveForm: async (id, f) => void forms.set(id, f),
		dropForm: async (id) => forms.delete(id),
		forms: async () => [...forms],
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

// Клієнт OpenCode, що записує виклики; сесії, активні й подані події задаються в тесті.
export function fakeOpencode(init: { active?: string[]; info?: Record<string, import("../src/domain/agent").SessionInfo>; assistant?: Record<string, { text: string; error?: string }>; events?: (import("../src/domain/agent").OpencodeEvent | undefined)[] } = {}) {
	const calls = { replies: [] as { ocId: string; formId: string; answer: FormAnswers }[], cancels: [] as { ocId: string; formId: string; message?: string }[], interrupts: [] as string[], prompts: [] as { ocId: string; text: string }[] };
	const client: OpencodeClient = {
		prompt: async (ocId, text) => void calls.prompts.push({ ocId, text }),
		replyForm: async (ocId, formId, answer) => void calls.replies.push({ ocId, formId, answer }),
		cancelForm: async (ocId, formId, message) => void calls.cancels.push({ ocId, formId, message }),
		session: async (ocId) => init.info?.[ocId] ?? {},
		interrupt: async (ocId) => void calls.interrupts.push(ocId),
		activeSessions: async () => init.active ?? [],
		lastAssistant: async (ocId) => init.assistant?.[ocId] ?? { text: "" },
		events: async (_signal, onEvent) => {
			for (const e of init.events ?? []) await onEvent(e);
		},
	};
	return { client, calls };
}

// Пост у чаті, що записує показані стани й іконки.
export function fakePosts() {
	const shown: { id: string; status: string; final: boolean; answers?: { labels: string[]; multiple?: boolean } }[] = [];
	const marks: boolean[] = [];
	const icons: string[] = [];
	const renames: string[] = [];
	let queue: Promise<unknown> = Promise.resolve();
	const posts: PostBoard = {
		show: async (id, _w, status, final = false, answers) => (shown.push({ id, status, final, answers }), true),
		enqueue: (edit) => (queue = queue.catch(() => undefined).then(edit)),
		settled: async () => void (await queue.catch(() => undefined)),
		mark: async (_w, on) => void marks.push(on),
		icon: async (_w, state) => void icons.push(state),
		rename: async (_w, title) => (renames.push(title), true),
	};
	return { posts, shown, marks, icons, renames };
}

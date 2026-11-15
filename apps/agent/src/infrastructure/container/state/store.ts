import type { SessionStore as SessionStorePort } from "../../../domain/agent";
import { LIMIT_PREFIX, SESSION_PREFIX, WATCH_PREFIX, jobKey, limitKey, sessionId, sessionKey, watchId, watchKey, type Job, type LimitWait, type Tracked, type Watch } from "./state";

const JOB_PREFIX = jobKey("");

// Записи сесій у сховищі Durable Object: сесії, спостереження, прийняті завдання й очікування лімітів. Модулі працюють з id сесії, а
// ключі (`session:<id>`…, див. state.ts) знає лише цей клас. Сесій небагато (десятки), тож пошук перебирає їх.
export class SessionStore implements SessionStorePort {
	constructor(private readonly storage: DurableObjectStorage) {}

	session(id: string): Promise<Tracked | undefined> {
		return this.storage.get<Tracked>(sessionKey(id));
	}

	saveSession(id: string, tracked: Tracked): Promise<void> {
		return this.storage.put(sessionKey(id), tracked);
	}

	dropSession(id: string): Promise<unknown> {
		return this.storage.delete(sessionKey(id));
	}

	async sessions(): Promise<[string, Tracked][]> {
		return [...(await this.storage.list<Tracked>({ prefix: SESSION_PREFIX }))].map(([key, t]) => [sessionId(key), t]);
	}

	// Сесія за id сесії OpenCode.
	async sessionByOc(ocId: string): Promise<[string, Tracked] | undefined> {
		return (await this.sessions()).find(([, t]) => t.ocId === ocId);
	}

	// Сесія гілки agent/<folder>: тека збігається, а репозиторій той самий або не визначений (anyRepo), якщо так дозволено.
	async sessionByBranch(repo: string, folder: string, anyRepo: boolean): Promise<[string, Tracked] | undefined> {
		return (await this.sessions()).find(([id, t]) => (t.folder ?? id) === folder && (t.repo === repo || (anyRepo && !t.repo)));
	}

	watch(id: string): Promise<Watch | undefined> {
		return this.storage.get<Watch>(watchKey(id));
	}

	saveWatch(id: string, w: Watch): Promise<void> {
		return this.storage.put(watchKey(id), w);
	}

	dropWatch(id: string): Promise<unknown> {
		return this.storage.delete(watchKey(id));
	}

	async watches(): Promise<[string, Watch][]> {
		return [...(await this.storage.list<Watch>({ prefix: WATCH_PREFIX }))].map(([key, w]) => [watchId(key), w]);
	}

	async watchByOc(ocId: string): Promise<[string, Watch] | undefined> {
		return (await this.watches()).find(([, w]) => w.ocId === ocId);
	}

	async watching(): Promise<boolean> {
		return (await this.storage.list({ prefix: WATCH_PREFIX, limit: 1 })).size > 0;
	}

	job(id: string): Promise<Job | undefined> {
		return this.storage.get<Job>(jobKey(id));
	}

	saveJob(job: Job): Promise<void> {
		return this.storage.put(jobKey(job.id), job);
	}

	dropJob(id: string): Promise<unknown> {
		return this.storage.delete(jobKey(id));
	}

	async jobs(): Promise<Job[]> {
		return [...(await this.storage.list<Job>({ prefix: JOB_PREFIX })).values()];
	}

	limit(id: string): Promise<LimitWait | undefined> {
		return this.storage.get<LimitWait>(limitKey(id));
	}

	saveLimit(id: string, wait: LimitWait): Promise<void> {
		return this.storage.put(limitKey(id), wait);
	}

	dropLimit(id: string): Promise<unknown> {
		return this.storage.delete(limitKey(id));
	}

	async limits(): Promise<[string, LimitWait][]> {
		return [...(await this.storage.list<LimitWait>({ prefix: LIMIT_PREFIX }))].map(([key, w]) => [key.slice(LIMIT_PREFIX.length), w]);
	}
}

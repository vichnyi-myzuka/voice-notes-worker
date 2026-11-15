import type { DeployInfo, LastShown, PostRef, PostStore } from "../../../domain/agent";
import { deployKey, lastKey, refKey } from "./state";

// Записи про пости сесій у сховищі Durable Object (ключі deploy:/last:/ref:, див. state.ts).
export class PostRecords implements PostStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	deploy(postId: number): Promise<DeployInfo | undefined> {
		return this.storage.get<DeployInfo>(deployKey(postId));
	}

	saveDeploy(postId: number, deploy: DeployInfo): Promise<void> {
		return this.storage.put(deployKey(postId), deploy);
	}

	last(postId: number): Promise<LastShown | undefined> {
		return this.storage.get<LastShown>(lastKey(postId));
	}

	saveLast(postId: number, last: LastShown): Promise<void> {
		return this.storage.put(lastKey(postId), last);
	}

	saveRef(key: string, ref: PostRef): Promise<void> {
		return this.storage.put(refKey(key), ref);
	}

	async takeRef(key: string): Promise<PostRef | undefined> {
		const ref = await this.storage.get<PostRef>(refKey(key));
		if (ref) await this.storage.delete(refKey(key));
		return ref;
	}

	async forget(postId: number): Promise<void> {
		await Promise.all([this.storage.delete(deployKey(postId)), this.storage.delete(lastKey(postId))]);
	}
}

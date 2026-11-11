

export async function openSteps<S extends object>(env: { BUCKET: R2Bucket }, stateKey: string, lastAttempt: boolean): Promise<Steps<S>> {
	const state: S = (await (await env.BUCKET.get(stateKey))?.json<S>()) ?? ({} as S);
	const save = () => env.BUCKET.put(stateKey, JSON.stringify(state));
	const step: Steps<S>["step"] = async (name, fn, opts) => {
		type V = Exclude<S[typeof name], undefined>;
		if (state[name] !== undefined) return state[name] as V;
		let value: V;
		try {
			value = await fn();
		} catch (err) {
			if (!lastAttempt || !opts?.onFinalFailure) throw err;
			console.error(`step ${String(name)} failed on the last attempt:`, err);
			value = opts.onFinalFailure();
		}
		state[name] = value;
		await save();
		return value;
	};
	return { state, lastAttempt, save, step };
}

export type Options<V> = { onFinalFailure?: () => V };

export type Steps<S> = {
	state: S;
	lastAttempt: boolean;
	save: () => Promise<unknown>;
	step: <K extends keyof S>(name: K, fn: () => Promise<Exclude<S[K], undefined>>, opts?: Options<Exclude<S[K], undefined>>) => Promise<Exclude<S[K], undefined>>;
};

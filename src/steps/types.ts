export type Options<V> = { onFinalFailure?: () => V };

export type Steps<S> = {
	state: S;
	lastAttempt: boolean;
	save: () => Promise<unknown>;
	step: <K extends keyof S>(name: K, fn: () => Promise<Exclude<S[K], undefined>>, opts?: Options<Exclude<S[K], undefined>>) => Promise<Exclude<S[K], undefined>>;
};

/**
 * oneShot — settle-once promise with a guaranteed cleanup hook.
 *
 * Many of our async entry points (pi rpc subprocess per node, planner
 * attempt) race several terminal signals: agent_settled vs process exit
 * vs timeout vs abort. The classic shape — `settled` flag + `finish()`
 * closure + cleanup() before resolve — recurs in identical form across
 * `pi-node-executor.ts` and `planner.ts`. This helper captures the shape
 * so each caller only supplies the cleanup behavior (kill the bridge,
 * clear timers, remove event listeners, drop temp files).
 *
 * `finish` is idempotent — the first call wins, every subsequent call is
 * a no-op. This is what makes the "many paths race, only one resolves
 * the promise" pattern safe.
 */

export interface OneShot<T> {
	/** Promise that resolves when the first `finish` call wins. */
	promise: Promise<T>;
	/** Idempotent terminator: first call runs `cleanup` and resolves the
	 *  promise; subsequent calls are no-ops. */
	finish(result: T): void;
}

/**
 * Create a one-shot promise + cleanup-bound finisher.
 *
 * @param cleanup  Called ONCE — right before the promise resolves, after
 *                 any racing paths have lost. This is where you kill
 *                 subprocesses, clear timers, drop event listeners, etc.
 */
export function oneShot<T>(cleanup: () => void): OneShot<T> {
	let settled = false;
	let resolve: (r: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	const finish = (result: T): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(result);
	};
	return { promise, finish };
}

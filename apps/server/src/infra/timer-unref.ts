/**
 * setTimeoutUnref — create a timer that does NOT keep the process alive.
 *
 * The Node.js process keeps running while any timer (or socket) is alive
 * unless the timer is "unref'd". Background tasks that should let the server
 * exit cleanly (delta-flush windows, node/planner timeouts, etc.) wrap
 * setTimeout here so the cast never has to be repeated at every call site.
 */

/** Alias for a NodeJS.Timeout — kept for documentation / type-narrowing intent. */
export type UnrefableTimeout = ReturnType<typeof setTimeout>;

/** Spawn a timeout that will not keep the event loop alive. */
export function setTimeoutUnref(handler: () => void, ms: number): UnrefableTimeout {
	const timer = setTimeout(handler, ms);
	// Node's setTimeout return type carries unref() at runtime; the public
	// type omits it to discourage non-platform callers. Cast once here.
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

/**
 * Archive-id allowlists — the single source for "is this a safe id?".
 *
 * Session archives use millisecond timestamps as ids (e.g. `2026-08-21T01-38-58-392Z`),
 * and run ids use `orch-<base36>-<seq>` (e.g. `orch-mx1y2z3-1`). Both are
 * filename-safe by construction, but the store `read()` / `rename()` paths
 * take user-supplied ids from URL params — a permissive regex there lets
 * `../../etc/passwd` reach `existsSync()`. Centralizing the regex ensures
 * every call site agrees on what an id looks like.
 */

/** Session-archive id charset: digits, capital T, Z, and hyphens. */
export const SESSION_ID_RE = /^[0-9TZ-]+$/;

/** Run-archive id charset: ASCII alphanumerics plus hyphens. */
export const RUN_ID_RE = /^[A-Za-z0-9-]+$/;

/** Strict id guard for the session-archive paths (read / rename / resume). */
export function isSessionId(id: string): boolean {
	return SESSION_ID_RE.test(id);
}

/** Strict id guard for the run-archive paths (read / list / delete). */
export function isRunId(id: string): boolean {
	return RUN_ID_RE.test(id);
}

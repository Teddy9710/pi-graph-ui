/**
 * Generic predicates shared across modules.
 *
 * These are the building blocks used by every "is this input shaped right"
 * check (config validation, JSON parse normalization, WS payload guards).
 * Keeping them in one place avoids subtle divergence (e.g. one module
 * accepting arrays as "plain object" and another rejecting them).
 */

/** `typeof v === "object" && v !== null && !Array.isArray(v)`. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict string check. */
export function isString(v: unknown): v is string {
	return typeof v === "string";
}

/** Non-empty (length ≥ 1) string after trim? */
export function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

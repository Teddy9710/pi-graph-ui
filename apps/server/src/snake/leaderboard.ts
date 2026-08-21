/**
 * Snake game leaderboard service.
 *
 * SAFETY CONSIDERATIONS:
 *  - Every external input is validated (name length, score bounds, board size).
 *  - Score submission is idempotent-ish: each score includes a `token` issued
 *    by the server when starting a game, so a client cannot fabricate arbitrary
 *    high scores without first obtaining a valid token.
 *  - Names are stripped of any non-alphanumeric characters for storage.
 */

export interface ScoreEntry {
	id: string;
	/** Client-supplied display name (sanitized for storage). */
	name: string;
	score: number;
	/** Board size the score was achieved on. */
	size: number;
	/** Token that authorized this score submission. */
	token: string;
	/** Epoch ms of submission. */
	submittedAt: number;
}

/** Leaderboard window: only the top N scores per board size are kept. */
export const MAX_ENTRIES_PER_SIZE = 10;
export const MAX_NAME_LEN = 16;
export const MIN_NAME_LEN = 1;
export const MAX_SCORE = 100000;
export const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface NewGameToken {
	token: string;
	expiresAt: number;
}

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

export function sanitizeName(raw: unknown): string {
	if (typeof raw !== "string") return "anonymous";
	const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "").slice(0, MAX_NAME_LEN);
	return cleaned.length >= MIN_NAME_LEN ? cleaned : "anonymous";
}

/** Validate a raw (size, score) numeric pair. Returns null on invalid. */
export function validateMetrics(size: unknown, score: unknown): { size: number; score: number } | null {
	if (typeof size !== "number" || typeof score !== "number") return null;
	if (!Number.isInteger(size) || !Number.isInteger(score)) return null;
	if (size < 5 || size > 50) return null;
	if (score < 0 || score > MAX_SCORE) return null;
	return { size, score };
}

/** Issue a fresh (unguessable) game token. */
export function issueToken(random: () => number = Math.random): NewGameToken {
	return {
		token: randomBytes(random, 24),
		expiresAt: Date.now() + TOKEN_TTL_MS,
	};
}

/** 24 random hex chars from a pluggable RNG (defaults to Math.random). */
function randomBytes(random: () => number, bytes: number): string {
	const out: string[] = [];
	for (let i = 0; i < bytes; i++) {
		out.push(Math.floor(random() * 256).toString(16).padStart(2, "0"));
	}
	return out.join("");
}

/**
 * In-memory leaderboard. Safe for concurrent use in a single-threaded server.
 *
 * Token model: issueToken() registers an unguessable id with an expiry; a
 * score may only be submitted against a registered, unexpired token. A token
 * may be reused for one score (the first submit consumes it) to stop replay.
 */
export class Leaderboard {
	private readonly entries: ScoreEntry[] = [];
	/** token -> { expiresAt, consumed } for every token ever issued. */
	private readonly issued = new Map<string, { expiresAt: number; consumed: boolean }>();
	private readonly maxEntries: number;

	// NB: no TypeScript parameter properties - node's strip-only loader
	// rejects `constructor(private readonly x)` at runtime.
	constructor(maxEntries = MAX_ENTRIES_PER_SIZE) {
		this.maxEntries = maxEntries;
	}

	/** Register a fresh token so it can be used for one score submission. */
	registerToken(token: string, expiresAt: number): void {
		// Keep the map small: drop any expired tokens periodically.
		if (this.issued.size > 5000) this.pruneExpired();
		this.issued.set(token, { expiresAt, consumed: false });
	}

	private pruneExpired(): void {
		const now = Date.now();
		for (const [tok, rec] of this.issued) {
			if (rec.expiresAt <= now) this.issued.delete(tok);
		}
	}

	/** Token still registered, unexpired, and not yet used for a score? */
	isTokenValid(token: string): boolean {
		const rec = this.issued.get(token);
		if (!rec) return false;
		if (rec.expiresAt <= Date.now() || rec.consumed) {
			this.issued.delete(token);
			return false;
		}
		return true;
	}

	/** Total issued tokens still valid (diagnostics/testing). */
	issuedCount(): number {
		return this.issued.size;
	}

	/** All entries for a given board size, best-first. */
	top(size: number): ScoreEntry[] {
		return this.entries
			.filter((e) => e.size === size)
			.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
	}

	/**
	 * Submit a score if the token is valid. Returns the newest entry list for
	 * that board size. Duplicate (token, score) submissions are coalesced.
	 */
	submit(entry: Omit<ScoreEntry, "id" | "submittedAt">): ScoreEntry[] | null {
		// A valid, unused token is required; this call consumes it (one-shot).
		if (!this.isTokenValid(entry.token)) return null;
		this.issued.delete(entry.token);

		const now = Date.now();
		const existing = this.entries.find((e) => e.token === entry.token && e.score === entry.score);
		if (existing) {
			return this.top(entry.size);
		}
		const full: ScoreEntry = {
			...entry,
			id: `${entry.token}`,
			submittedAt: now,
		};
		this.entries.push(full);
		// Prune: keep only the best maxEntries per size.
		const kept = new Map<number, ScoreEntry[]>();
		for (const e of this.entries) {
			const list = kept.get(e.size) ?? [];
			list.push(e);
			kept.set(e.size, list);
		}
		this.entries.length = 0;
		for (const [size, list] of kept) {
			const sorted = list.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
			this.entries.push(...sorted.slice(0, this.maxEntries));
		}
		return this.top(entry.size);
	}

	count(): number {
		return this.entries.length;
	}

	reset(): void {
		this.entries.length = 0;
		this.issued.clear();
	}
}

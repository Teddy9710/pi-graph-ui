/**
 * Hono router for the Snake game API.
 *
 * Routes:
 *   POST /api/snake/new    -> issue a game token for a given board size
 *   GET  /api/snake/top?size=20 -> top scores for a board size
 *   POST /api/snake/score  -> submit {token, name, size, score}
 *
 * Security notes:
 *   - `new` issues an expiring, unguessable token; scores without a valid
 *     token are rejected (4xx).
 *   - Board size is validated to a fixed range; names are sanitized.
 *   - Score is capped; negative / non-integer values rejected.
 */

import { Hono } from "hono";
import {

	Leaderboard,
	issueToken,
	sanitizeName,
	validateMetrics,
	type ScoreEntry,
} from "./leaderboard.ts";

export interface SnakeApi {
	leaderboard: Leaderboard;
}

export function snakeRoutes(api: SnakeApi): Hono {
	const app = new Hono();

	// Issue a token for starting a new game at a given board size.
	app.post("/new", async (c) => {
		let body: { size?: unknown };
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}
		const size = typeof body?.size === "number" ? body.size : 20;
		if (typeof size !== "number" || !Number.isInteger(size) || size < 5 || size > 50) {
			return c.json({ error: "size must be an integer in [5, 50]" }, 400);
		}
		const { token, expiresAt } = issueToken();
		api.leaderboard.registerToken(token, expiresAt);
		return c.json({ token, size, expiresAt });
	});

	// Top scores for a board size (default 20).
	app.get("/top", (c) => {
		const rawSize = c.req.query("size");
		const size = rawSize === undefined ? 20 : Number(rawSize);
		const metrics = validateMetrics(size, 0);
		if (!metrics) return c.json({ error: "size must be an integer in [5, 50]" }, 400);
		const top = api.leaderboard.top(metrics.size).map((e) => toPublic(e));
		return c.json({ size: metrics.size, scores: top });
	});

	// Submit a score. Rejects without/vs an invalid token.
	app.post("/score", async (c) => {
		let body: { token?: unknown; name?: unknown; size?: unknown; score?: unknown };
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}
		if (typeof body?.token !== "string" || !api.leaderboard.isTokenValid(body.token)) {
			return c.json({ error: "invalid or expired token" }, 401);
		}
		const metrics = validateMetrics(body.size, body.score);
		if (!metrics) {
			return c.json({ error: "size/score out of range" }, 400);
		}

		const entry: Omit<ScoreEntry, "id" | "submittedAt"> = {
			name: sanitizeName(body.name),
			score: metrics.score,
			size: metrics.size,
			token: body.token,
		};
		const top = api.leaderboard.submit(entry);
		if (top === null) {
			return c.json({ error: "token already used or expired" }, 401);
		}
		return c.json({ saved: true, rank: top.findIndex((e) => e.token === body.token) + 1, scores: top.map(toPublic) });
	});

	return app;
}

/** Strip internal fields (token, submittedAt) before sending to clients. */
function toPublic(e: ScoreEntry): { id: string; name: string; score: number; size: number } {
	return { id: e.id, name: e.name, score: e.score, size: e.size };
}

/** Re-export for tests/tooling. */
export { sanitizeName, validateMetrics, issueToken, Leaderboard };

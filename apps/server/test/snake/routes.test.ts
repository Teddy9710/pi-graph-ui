import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Leaderboard } from "../../src/snake/leaderboard.ts";
import { snakeRoutes } from "../../src/snake/routes.ts";

function makeApp(): { app: Hono; lb: Leaderboard } {
	const lb = new Leaderboard();
	return { app: snakeRoutes({ leaderboard: lb }), lb };
}

async function json(res: Response): Promise<any> {
	return res.json();
}

describe("POST /api/snake/new", () => {
	it("issues a token for a valid size", async () => {
		const { app } = makeApp();
		const res = await app.request("/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: 20 }) });
		expect(res.status).toBe(200);
		const data = await json(res);
		expect(data).toMatchObject({ size: 20 });
		expect(typeof data.token).toBe("string");
		expect(data.token.length).toBeGreaterThan(16);
	});

	it("rejects an out-of-range size", async () => {
		const { app } = makeApp();
		const res = await app.request("/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: 500 }) });
		expect(res.status).toBe(400);
	});
});

describe("POST /api/snake/score", () => {
	it("rejects scores without a valid token (401)", async () => {
		const { app } = makeApp();
		const res = await app.request("/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "hacked", name: "x", size: 20, score: 9999 }) });
		expect(res.status).toBe(401);
	});

	it("rejects valid-token but out-of-range metrics (400)", async () => {
		const { app } = makeApp();
		const tok = await app.request("/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: 20 }) });
		const { token } = await json(tok);
		const res = await app.request("/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name: "x", size: 20, score: -5 }) });
		expect(res.status).toBe(400);
	});

	it("saves a legitimate score and returns a rank", async () => {
		const { app } = makeApp();
		const tok = await app.request("/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: 20 }) });
		const { token } = await json(tok);
		const res = await app.request("/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name: "Alice_01", size: 20, score: 42 }) });
		expect(res.status).toBe(200);
		const data = await json(res);
		expect(data.saved).toBe(true);
		expect(data.rank).toBe(1);
		expect(data.scores[0]).toMatchObject({ name: "Alice_01", score: 42 });
		// No internal fields leaked to the client.
		expect(Object.keys(data.scores[0])).not.toContain("token");
		expect(Object.keys(data.scores[0])).not.toContain("expiresAt");
	});

	it("sanitizes a malicious display name before storage", async () => {
		const { app } = makeApp();
		const tok = await app.request("/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ size: 20 }) });
		const { token } = await json(tok);
		const res = await app.request("/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name: "<img src=x onerror=alert(1)>", size: 20, score: 7 }) });
		const data = await json(res);
		// No angle brackets survive -> safe to render as HTML later.
		expect(data.scores[0].name).not.toMatch(/[<>]/);
	});
});

describe("GET /api/snake/top", () => {
	it("returns top scores for a size", async () => {
		const { app, lb } = makeApp();
		const tok = (exp = 0) => {
			const t = { token: Math.random().toString(36).slice(2), expiresAt: Date.now() + 10000 + exp };
			lb.registerToken(t.token, t.expiresAt);
			return t.token;
		};
		lb.submit({ token: tok(), name: "a", size: 20, score: 10 });
		lb.submit({ token: tok(), name: "b", size: 20, score: 30 });
		const res = await app.request("/top?size=20");
		expect(res.status).toBe(200);
		const data = await json(res);
		expect(data.scores[0].score).toBe(30);
	});

	it("defaults to size 20 and rejects bad size", async () => {
		const { app } = makeApp();
		const ok = await app.request("/top");
		expect((await json(ok)).size).toBe(20);
		const bad = await app.request("/top?size=abc");
		expect(bad.status).toBe(400);
	});
});

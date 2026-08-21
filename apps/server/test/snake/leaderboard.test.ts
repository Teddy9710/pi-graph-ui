import { describe, expect, it } from "vitest";
import { Leaderboard, issueToken, sanitizeName, validateMetrics, MAX_ENTRIES_PER_SIZE } from "../../src/snake/leaderboard.ts";

describe("sanitizeName", () => {
	it("strips non-alphanumeric characters (XSS safety)", () => {
		expect(sanitizeName("<script>alert(1)</script>")).toBe("scriptalert1scri"); // 16-char truncation
		expect(sanitizeName("😀emoji!!")).toBe("emoji");
	});
	it("falls back to anonymous for empty / non-string", () => {
		expect(sanitizeName("")).toBe("anonymous");
		expect(sanitizeName("   ")).toBe("anonymous");
		expect(sanitizeName(null)).toBe("anonymous");
		expect(sanitizeName(123)).toBe("anonymous");
	});
	it("truncates over-long names", () => {
		expect(sanitizeName("a".repeat(100))).toHaveLength(16);
	});
	it("keeps safe names intact", () => {
		expect(sanitizeName("Alice_01")).toBe("Alice_01");
	});
});

describe("validateMetrics", () => {
	it("accepts valid integer size/score", () => {
		expect(validateMetrics(20, 42)).toEqual({ size: 20, score: 42 });
		expect(validateMetrics(20, 0)).toEqual({ size: 20, score: 0 });
	});
	it("rejects non-numbers and non-integers", () => {
		expect(validateMetrics("20" as unknown as number, 42)).toBeNull();
		expect(validateMetrics(20.5, 42)).toBeNull();
		expect(validateMetrics(20, 4.9)).toBeNull();
		expect(validateMetrics(20, "42" as unknown as number)).toBeNull();
	});
	it("rejects out-of-range size", () => {
		expect(validateMetrics(4, 10)).toBeNull();
		expect(validateMetrics(51, 10)).toBeNull();
	});
	it("rejects out-of-range score", () => {
		expect(validateMetrics(20, -1)).toBeNull();
		expect(validateMetrics(20, 100001)).toBeNull();
	});
});

describe("issueToken", () => {
	it("produces distinct unguessable tokens", () => {
		const a = issueToken().token;
		const b = issueToken().token;
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[0-9a-f]{48}$/); // 24 bytes -> 48 hex chars
	});
});

function registered(lb: Leaderboard, extra = 0) {
	const t = issueToken();
	lb.registerToken(t.token, t.expiresAt + extra);
	return t.token;
}

describe("Leaderboard", () => {
	it("rejects scores submitted without a valid token", () => {
		const lb = new Leaderboard();
		expect(lb.isTokenValid("bogus")).toBe(false);
		expect(lb.submit({ token: "bogus", name: "x", size: 20, score: 1 })).toBeNull();
	});

	it("submits and ranks scores best-first", () => {
		const lb = new Leaderboard();
		const entry = (name: string, score: number) => lb.submit({ token: registered(lb), name, size: 20, score });

		entry("alice", 30);
		entry("bob", 50);
		const top = lb.top(20);
		expect(top.map((e) => e.score)).toEqual([50, 30]);
		expect(top.map((e) => e.name)).toEqual(["bob", "alice"]);
		expect(lb.count()).toBe(2);
	});

	it("keeps only the top N entries per size", () => {
		const lb = new Leaderboard(MAX_ENTRIES_PER_SIZE);
		for (let i = 0; i < 20; i++) {
			lb.submit({ token: registered(lb), name: `p${i}`, size: 20, score: i });
		}
		const top = lb.top(20);
		expect(top.length).toBe(MAX_ENTRIES_PER_SIZE);
		expect(top[0].score).toBe(19);
		expect(top[top.length - 1].score).toBe(10);
		expect(lb.count()).toBe(MAX_ENTRIES_PER_SIZE);
	});

	it("coalesces duplicate token+score submissions", () => {
		const lb = new Leaderboard();
		const tok = registered(lb);
		lb.submit({ token: tok, name: "a", size: 20, score: 7 });
		// second submit with same (now-consumed) token is rejected
		expect(lb.submit({ token: tok, name: "a", size: 20, score: 7 })).toBeNull();
		expect(lb.count()).toBe(1);
	});

	it("separates leaderboards across board sizes", () => {
		const lb = new Leaderboard();
		lb.submit({ token: registered(lb), name: "small", size: 10, score: 5 });
		lb.submit({ token: registered(lb), name: "large", size: 20, score: 100 });
		expect(lb.top(10).length).toBe(1);
		expect(lb.top(20).length).toBe(1);
		expect(lb.top(30).length).toBe(0);
	});

	it("a token is one-shot: reused tokens are rejected", () => {
		const lb = new Leaderboard();
		const tok = registered(lb);
		expect(lb.submit({ token: tok, name: "first", size: 20, score: 10 })).not.toBeNull();
		expect(lb.submit({ token: tok, name: "cheat", size: 20, score: 99 })).toBeNull();
		expect(lb.top(20).length).toBe(1); // only first kept
	});

	it("expired tokens are invalid", () => {
		const lb = new Leaderboard();
		const t = issueToken();
		lb.registerToken(t.token, Date.now() - 1); // already expired
		expect(lb.isTokenValid(t.token)).toBe(false);
		expect(lb.submit({ token: t.token, name: "x", size: 20, score: 1 })).toBeNull();
	});
});

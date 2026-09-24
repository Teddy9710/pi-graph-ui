import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { OrchestratorEngine, type Executor, type ExecutorCall, type NodeResult } from "../src/orchestrator.ts";
import type { EdgeType, GraphDef, RunEvent } from "@pi-graph/shared";

// ============================================================================
// Fakes & helpers
// ============================================================================

type Ctx = { onDelta: (kind: "text" | "tool", delta: string) => void; signal: AbortSignal };

class FakeExecutor implements Executor {
	calls: ExecutorCall[] = [];
	started: string[] = [];
	peak = 0;
	private live = 0;
	/** Per-node behavior; nodes without an entry succeed with `out:<id>`. */
	script: Record<string, (ctx: Ctx) => Promise<NodeResult>> = {};

	async run(call: ExecutorCall, ctx: Ctx): Promise<NodeResult> {
		this.calls.push(call);
		this.started.push(call.node.id);
		this.live++;
		this.peak = Math.max(this.peak, this.live);
		try {
			const fn = this.script[call.node.id];
			return fn ? await fn(ctx) : { ok: true, text: `out:${call.node.id}` };
		} finally {
			this.live--;
		}
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const ok = (text: string, usage?: NodeResult["usage"]): NodeResult => ({ ok: true, text, usage });
const fail = (error: string): NodeResult => ({ ok: false, text: "", error });
/** A failure WITH a retryable/unretryable kind — drives the engine's retry policy. */
const failKind = (error: string, kind: NonNullable<NodeResult["kind"]>): NodeResult => ({ ok: false, text: "", error, kind });
const hangOnGate = <T>(gate: Promise<T>) => () => gate.then(() => ok("late"));
const hangOnAbort = (ctx: Ctx) =>
	new Promise<NodeResult>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));

/** Engine options the retry/seed/artifacts tests exercise beyond maxParallel. */
interface EngineExtras {
	defaultMaxRetries?: number;
	retryDelayMs?: number;
	precompleted?: ReadonlyMap<string, { text: string; fromRunId: string }>;
	artifactsRoot?: string;
}

interface Harness {
	executor: FakeExecutor;
	events: RunEvent[];
	run: (
		graph: GraphDef,
		maxParallel?: number,
		extra?: EngineExtras,
	) => Promise<{ status: string; ok: number; failed: number; skipped: number }>;
	/** An engine the test can abort/decide on (run hides it). */
	engine: (graph: GraphDef, maxParallel?: number, extra?: EngineExtras) => OrchestratorEngine;
}

function harness(): Harness {
	const executor = new FakeExecutor();
	const events: RunEvent[] = [];
	let t = 0;
	const build = (graph: GraphDef, maxParallel?: number, extra?: EngineExtras) =>
		new OrchestratorEngine(graph, executor, {
			runId: "r-test",
			maxParallel,
			now: () => ++t,
			onEvent: (e) => events.push(e),
			defaultMaxRetries: extra?.defaultMaxRetries,
			retryDelayMs: extra?.retryDelayMs,
			precompleted: extra?.precompleted,
			artifactsRoot: extra?.artifactsRoot,
		});
	return { executor, events, run: (g, mp, extra) => build(g, mp, extra).run(), engine: build };
}

const node = (id: string, task = `task ${id}`) => ({ id, task });
const edge = (source: string, target: string, type?: EdgeType, label?: string) => ({
	id: `${source}->${target}`,
	source,
	target,
	...(type ? { type } : {}),
	...(label ? { label } : {}),
});

// ============================================================================
// Tests
// ============================================================================

describe("OrchestratorEngine", () => {
	it("injects upstream outputs into downstream prompts along a serial chain", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b"), edge("b", "c")] };
		const summary = await h.run(graph);
		expect(summary.status).toBe("completed");
		const callA = h.executor.calls.find((c) => c.node.id === "a")!;
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		const callC = h.executor.calls.find((c) => c.node.id === "c")!;
		// Core contract: outputs flow through assemblePrompt into the next task.
		expect(callA.assembledPrompt).toBe("task a");
		expect(callB.assembledPrompt).toContain("out:a");
		expect(callB.assembledPrompt).toContain("## 上游输入");
		expect(callC.assembledPrompt).toContain("out:b");
		expect(callC.assembledPrompt).not.toContain("out:a"); // only direct upstreams
	});

	it("typed edges annotate the upstream injection (badge + optional note)", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), node("b"), node("c")],
			edges: [edge("a", "b", "review", "提供初稿"), edge("b", "c")],
		};
		const summary = await h.run(graph);
		expect(summary.status).toBe("completed");
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		const callC = h.executor.calls.find((c) => c.node.id === "c")!;
		expect(callB.assembledPrompt).toContain("### from a —— 审校（提供初稿）");
		expect(callB.upstream[0]?.type).toBe("review");
		expect(callB.upstream[0]?.label).toBe("提供初稿");
		// A bare edge carries the DEFAULT badge — no bare headers anymore.
		expect(callC.assembledPrompt).toContain("### from b —— 输入\nout:b");
	});

	it("caps root concurrency at maxParallel", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b"), node("c"), node("d")], edges: [] };
		const gate = deferred<void>();
		for (const id of ["a", "b", "c", "d"]) h.executor.script[id] = hangOnGate(gate.promise);
		const runP = h.run(graph, 2);
		await new Promise((r) => setTimeout(r, 10));
		expect(h.executor.peak).toBe(2);
		gate.resolve();
		const summary = await runP;
		expect(summary.ok).toBe(4);
	});

	it("AND-join waits for ALL upstreams and receives every output", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), node("b"), node("c"), node("d")],
			edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
		};
		const gate = deferred<void>();
		h.executor.script.c = hangOnGate(gate.promise);
		const runP = h.run(graph);
		await new Promise((r) => setTimeout(r, 10));
		// b finished instantly, c is gated — d must NOT have started.
		expect(h.executor.started).toContain("b");
		expect(h.executor.started).not.toContain("d");
		gate.resolve();
		await runP;
		const callD = h.executor.calls.find((c) => c.node.id === "d")!;
		expect(callD.upstream.map((u) => u.nodeId)).toEqual(["b", "c"]); // graph order
		expect(callD.assembledPrompt).toContain("out:b");
		expect(callD.assembledPrompt).toContain("### from c");
		expect(callD.assembledPrompt).toContain("late"); // c's gated output
	});

	it("an upstream failure skips the downstream closure immediately (join waits no longer)", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), node("b"), node("c"), node("d")],
			edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
		};
		const gate = deferred<void>();
		h.executor.script.b = hangOnGate(gate.promise); // healthy branch still running
		h.executor.script.c = async () => fail("model exploded");
		const runP = h.run(graph);
		await new Promise((r) => setTimeout(r, 10));
		// d is skipped the moment c fails — b is still in flight.
		expect(h.events.some((e) => e.type === "node_skipped" && e.nodeId === "d")).toBe(true);
		expect(h.executor.started).not.toContain("d");
		gate.resolve();
		const summary = await runP;
		expect(summary.status).toBe("failed");
		expect(summary.ok).toBe(2); // a + b
		expect(summary.failed).toBe(1); // c
		expect(summary.skipped).toBe(1); // d
	});

	it("sibling branches are unaffected by a failure elsewhere", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), node("b"), node("x"), node("y")],
			edges: [edge("a", "b"), edge("x", "y")],
		};
		h.executor.script.a = async () => fail("boom");
		const summary = await h.run(graph);
		// b is a's downstream: skipped (never started). x/y run to completion.
		expect(h.executor.started.sort()).toEqual(["a", "x", "y"]);
		expect(summary.status).toBe("failed");
		expect(summary.ok).toBe(2); // x + y
		expect(summary.skipped).toBe(1); // b
	});

	it("abort: pending nodes are skipped, queued never start, status aborted", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), node("b")],
			edges: [edge("a", "b")],
		};
		h.executor.script.a = hangOnAbort;
		const engine = new OrchestratorEngine(graph, h.executor, {
			runId: "r-abort",
			onEvent: (e) => h.events.push(e),
		});
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		engine.abort();
		const summary = await runP;
		expect(summary.status).toBe("aborted");
		expect(h.executor.started).toEqual(["a"]); // b never launched
		const skipB = h.events.find((e) => e.type === "node_skipped" && e.nodeId === "b");
		expect(skipB).toBeDefined();
		const fin = h.events.find((e) => e.type === "run_finished");
		expect(fin && fin.type === "run_finished" ? fin.status : "").toBe("aborted");
	});

	it("rejects a cyclic graph at construction", () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), node("b")],
			edges: [edge("a", "b"), edge("b", "a")],
		};
		expect(() => new OrchestratorEngine(graph, h.executor, { runId: "r", onEvent: () => {} })).toThrow(/cycle/);
	});

	it("a throwing executor becomes node_failed (not a crash)", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };
		h.executor.script.a = async () => {
			throw new Error("executor blew up");
		};
		const summary = await h.run(graph);
		expect(summary.status).toBe("failed");
		const failedEv = h.events.find((e) => e.type === "node_failed");
		expect(failedEv && failedEv.type === "node_failed" ? failedEv.error : "").toContain("executor blew up");
	});

	it("aggregates usage and counts in run_finished", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [] };
		const u = { input: 10, output: 20, totalTokens: 30, cost: 0.5 };
		h.executor.script.a = async () => ok("a", u);
		h.executor.script.b = async () => ok("b", u);
		const summary = await h.run(graph);
		const fin = h.events.find((e) => e.type === "run_finished");
		expect(summary.ok).toBe(2);
		if (fin && fin.type === "run_finished") {
			expect(fin.usage.totalTokens).toBe(60);
			expect(fin.usage.cost).toBeCloseTo(1);
		} else {
			throw new Error("run_finished missing");
		}
	});

	it("forwards executor deltas as node_delta events", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a")], edges: [] };
		h.executor.script.a = async (ctx) => {
			ctx.onDelta("text", "正在");
			ctx.onDelta("text", "思考");
			ctx.onDelta("tool", "→ bash\n");
			return ok("done");
		};
		await h.run(graph);
		const deltas = h.events.filter((e) => e.type === "node_delta");
		expect(deltas.map((d) => (d.type === "node_delta" ? d.delta : ""))).toEqual(["正在", "思考", "→ bash\n"]);
	});

	it("completes an empty-node graph with zero counts", async () => {
		const h = harness();
		const summary = await h.run({ nodes: [], edges: [] });
		expect(summary).toEqual({ status: "completed", ok: 0, failed: 0, skipped: 0 });
	});
});

// ============================================================================
// Node capability profile plumbing (节点档案)
// ============================================================================

describe("capability profile plumbing", () => {
	it("a salvaged NodeResult (attempts=2) surfaces on node_completed", async () => {
		const h = harness();
		h.executor.script.a = async () => ({ ok: true, text: "第一次有点短", attempts: 2 });
		await h.run({ nodes: [node("a")], edges: [] });
		const completed = h.events.find((e) => e.type === "node_completed") as Extract<RunEvent, { type: "node_completed" }>;
		expect(completed.output.attempts).toBe(2);
		// Without the flag the field is absent (not 0) — old archives stay shape-compatible.
		h.events.length = 0;
		await h.run({ nodes: [node("b")], edges: [] });
		const plain = h.events.find((e) => e.type === "node_completed") as Extract<RunEvent, { type: "node_completed" }>;
		expect(plain.output.attempts).toBeUndefined();
	});

	it("the upstream node's outputCapBytes rides UpstreamInput and caps the injection", async () => {
		const h = harness();
		const longText = "z".repeat(300);
		h.executor.script.a = async () => ({ ok: true, text: longText });
		const graph: GraphDef = {
			nodes: [ { id: "a", task: "task a", outputCapBytes: 100 }, node("b") ],
			edges: [edge("a", "b")],
		};
		await h.run(graph);
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB.upstream[0]!.capBytes).toBe(100);
		// The shared assemblePrompt honored the per-node budget (100 bytes <
		// 300 z's → truncated with the marker).
		expect(callB.assembledPrompt).toContain("（输出过长，已截断）");

		// Without outputCapBytes the default 50KB budget applies (no truncation).
		const h2 = harness();
		h2.executor.script.a = async () => ({ ok: true, text: longText });
		await h2.run({ nodes: [node("a"), node("b")], edges: [edge("a", "b")] });
		const callB2 = h2.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB2.upstream[0]!.capBytes).toBeUndefined();
		expect(callB2.assembledPrompt).not.toContain("（输出过长，已截断）");
	});
});

// ============================================================================
// Gate nodes (HITL: suspend as awaiting, human approve/reject)
// ============================================================================

describe("gate nodes", () => {
	const gate = (id: string, task = `task ${id}`) => ({ id, task, gate: true });

	/** An engine the test can decide gates on (harness.run hides the engine). */
	function gateEngine(h: Harness, graph: GraphDef, maxParallel?: number): OrchestratorEngine {
		let t = 0;
		return new OrchestratorEngine(graph, h.executor, {
			runId: "r-gate",
			maxParallel,
			now: () => ++t,
			onEvent: (e) => h.events.push(e),
		});
	}

	it("suspends a ready gate as awaiting without calling the executor or taking a slot", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), gate("g"), node("b")], edges: [] };
		h.executor.script.a = hangOnAbort; // occupies the only slot forever
		const engine = gateEngine(h, graph, 1);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		const awaiting = h.events.find((e) => e.type === "node_awaiting" && e.nodeId === "g");
		expect(awaiting).toBeDefined();
		// The reviewer sees what the gate guards: the task (here, no upstreams).
		if (awaiting && awaiting.type === "node_awaiting") expect(awaiting.assembledPrompt).toBe("task g");
		expect(h.executor.started).toEqual(["a"]); // gate never dispatched; b still queued behind the slot
		expect(h.executor.peak).toBe(1);
		engine.abort();
		await runP;
	});

	it("a gate queued BEHIND a slot-blocked node still suspends immediately", async () => {
		const h = harness();
		// maxParallel 1: slow holds the only slot forever, x blocks behind it —
		// the scan must step OVER parked x and suspend g anyway (regression:
		// the drain loop used to break at x and strand g until a slot freed).
		const graph: GraphDef = { nodes: [node("slow"), node("x"), gate("g")], edges: [] };
		h.executor.script.slow = hangOnAbort;
		const engine = gateEngine(h, graph, 1);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		expect(h.events.some((e) => e.type === "node_awaiting" && e.nodeId === "g")).toBe(true);
		expect(h.executor.started).toEqual(["slow"]); // x parked, not launched
		engine.abort();
		await runP;
		// Parked x was skipped by the abort, never dispatched.
		expect(h.executor.started).toEqual(["slow"]);
	});

	it("approval unlocks the downstream closure and the note becomes its output", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), gate("g"), node("b")],
			edges: [edge("a", "g"), edge("g", "b")],
		};
		const engine = gateEngine(h, graph);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		// a ran; g awaits with a's output as the review material.
		const awaiting = h.events.find((e) => e.type === "node_awaiting" && e.nodeId === "g");
		if (awaiting && awaiting.type === "node_awaiting") expect(awaiting.assembledPrompt).toContain("out:a");
		expect(h.executor.started).toEqual(["a"]);
		expect(engine.decideNode("g", true, "  审校通过  ")).toBe(true);
		const summary = await runP;
		expect(summary.status).toBe("completed");
		// Approved gates tally into ok like completions — the rejection/abort
		// tests count the gate in failed, so the summary stays symmetric.
		expect(summary.ok).toBe(3); // a + the approved gate + b
		// The trimmed note is injected downstream like any upstream output.
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB.assembledPrompt).toContain("### from g");
		expect(callB.assembledPrompt).toContain("审校通过");
		const decided = h.events.find((e) => e.type === "node_decided");
		if (decided && decided.type === "node_decided") {
			expect(decided.approved).toBe(true);
			expect(decided.note).toBe("  审校通过  "); // raw note; trimming is the fold's job
			expect(decided.durationMs).toBeGreaterThan(0); // measured from entering awaiting
		} else {
			throw new Error("node_decided missing");
		}
	});

	it("an approval without a usable note defaults the gate output to （已批准）", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [gate("g"), node("b")], edges: [edge("g", "b")] };
		const engine = gateEngine(h, graph);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		expect(engine.decideNode("g", true, "   ")).toBe(true);
		await runP;
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB.assembledPrompt).toContain("（已批准）");
	});

	it("a rejection propagates like a node failure: downstream skipped with the standard reason", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("a"), gate("g"), node("b")],
			edges: [edge("a", "g"), edge("g", "b")],
		};
		const engine = gateEngine(h, graph);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		expect(engine.decideNode("g", false, "数据可疑")).toBe(true);
		const summary = await runP;
		expect(summary.status).toBe("failed");
		expect(summary.failed).toBe(1); // the gate itself
		expect(summary.skipped).toBe(1); // b
		expect(h.executor.started).toEqual(["a"]); // b never dispatched
		const skipB = h.events.find((e) => e.type === "node_skipped" && e.nodeId === "b");
		if (skipB && skipB.type === "node_skipped") expect(skipB.reason).toBe("upstream failed: g");
		else throw new Error("node_skipped for b missing");
	});

	it("decideNode on a non-awaiting node returns false and emits nothing", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), gate("g")], edges: [] };
		const engine = gateEngine(h, graph);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		const before = h.events.length;
		expect(engine.decideNode("a", true, "")).toBe(false); // ordinary node, already ok
		expect(engine.decideNode("nope", true, "")).toBe(false); // unknown id
		expect(h.events.length).toBe(before); // no event either way
		expect(engine.decideNode("g", true, "")).toBe(true);
		expect(engine.decideNode("g", false, "第二次")).toBe(false); // already decided
		await runP;
		expect(h.events.filter((e) => e.type === "node_decided")).toHaveLength(1);
	});

	it("an undecided gate keeps the run open (run_finished waits for the decision)", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), gate("g")], edges: [] };
		const engine = gateEngine(h, graph);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 20)); // everything else settled long ago
		expect(h.events.some((e) => e.type === "run_finished")).toBe(false);
		expect(engine.decideNode("g", true, "")).toBe(true);
		const summary = await runP;
		expect(summary.status).toBe("completed");
	});

	it("abort settles an awaiting gate like a running node: failed, downstream skipped", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [gate("g"), node("b")], edges: [edge("g", "b")] };
		const engine = gateEngine(h, graph);
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 10));
		engine.abort();
		const summary = await runP;
		expect(summary.status).toBe("aborted");
		const failedG = h.events.find((e) => e.type === "node_failed" && e.nodeId === "g");
		if (failedG && failedG.type === "node_failed") expect(failedG.error).toBe("已中止");
		else throw new Error("node_failed for the aborted gate missing");
		const skipB = h.events.find((e) => e.type === "node_skipped" && e.nodeId === "b");
		if (skipB && skipB.type === "node_skipped") expect(skipB.reason).toBe("run aborted");
		// Aborted-settled gates no longer accept a decision.
		expect(engine.decideNode("g", true, "")).toBe(false);
	});
});

// ============================================================================
// Engine-level auto-retry (timeout / process / model kinds, node_retry events)
// ============================================================================

describe("engine auto-retry", () => {
	it("a retryable failure re-executes under node_retry — never an intermediate node_failed", async () => {
		const h = harness();
		let n = 0;
		h.executor.script.a = async () => (++n === 1 ? failKind("节点超时（1000ms）", "timeout") : ok("recovered"));
		const summary = await h.run({ nodes: [node("a")], edges: [] }, 4, { defaultMaxRetries: 1 });
		expect(summary.status).toBe("completed");
		expect(summary.ok).toBe(1);
		expect(h.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(2);
		const retry = h.events.find((e) => e.type === "node_retry");
		if (!retry || retry.type !== "node_retry") throw new Error("node_retry missing");
		expect(retry.nodeId).toBe("a");
		expect(retry.attempt).toBe(2); // the execution about to start
		expect(retry.maxAttempts).toBe(2); // maxRetries + 1
		expect(retry.error).toContain("节点超时");
		expect(retry.retryInMs).toBe(0);
		// Event ORDER: node_started → node_retry → node_completed; no node_failed.
		const types = h.events.map((e) => e.type);
		expect(types.indexOf("node_retry")).toBeGreaterThan(types.indexOf("node_started"));
		expect(types.indexOf("node_completed")).toBeGreaterThan(types.indexOf("node_retry"));
		expect(types).not.toContain("node_failed");
	});

	it("config/aborted/internal failures (and an ABSENT kind) never retry", async () => {
		for (const r of [
			failKind("model「a|b」含非法字符", "config"),
			failKind("已中止", "aborted"),
			failKind("internal bug", "internal"),
			fail("no kind at all"), // old executors / adversarial results
		]) {
			const h = harness();
			h.executor.script.a = async () => r;
			const summary = await h.run({ nodes: [node("a")], edges: [] }, 4, { defaultMaxRetries: 3 });
			expect(summary.status).toBe("failed");
			expect(h.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(1);
			expect(h.events.some((e) => e.type === "node_retry")).toBe(false);
		}
	});

	it("per-node maxRetries overrides the engine default in BOTH directions", async () => {
		// Node override 0 beats engine default 1 → no retry at all.
		const h0 = harness();
		h0.executor.script.a = async () => failKind("节点超时（1000ms）", "timeout");
		const s0 = await h0.run({ nodes: [{ id: "a", task: "task a", maxRetries: 0 }], edges: [] }, 4, { defaultMaxRetries: 1 });
		expect(s0.failed).toBe(1);
		expect(h0.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(1);

		// Node override 2 beats engine default 0 → the third attempt succeeds.
		const h2 = harness();
		let n = 0;
		h2.executor.script.a = async () => (++n < 3 ? failKind("pi 进程退出 (code 1)", "process") : ok("third time lucky"));
		const s2 = await h2.run({ nodes: [{ id: "a", task: "task a", maxRetries: 2 }], edges: [] });
		expect(s2.status).toBe("completed");
		expect(h2.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(3);
		const retries = h2.events.filter((e) => e.type === "node_retry");
		expect(retries.map((r) => (r.type === "node_retry" ? r.attempt : 0))).toEqual([2, 3]);
	});

	it("abort during the retry delay settles the node (failed 已中止) without another attempt", async () => {
		const h = harness();
		h.executor.script.a = async () => failKind("节点超时（1000ms）", "timeout");
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };
		const engine = h.engine(graph, 4, { defaultMaxRetries: 2, retryDelayMs: 200 });
		const runP = engine.run();
		await new Promise((r) => setTimeout(r, 20)); // inside the first inter-attempt delay
		expect(h.events.some((e) => e.type === "node_retry" && e.nodeId === "a")).toBe(true);
		expect(h.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(1);
		engine.abort();
		const summary = await runP;
		expect(summary.status).toBe("aborted");
		const failedA = h.events.find((e) => e.type === "node_failed" && e.nodeId === "a");
		if (!failedA || failedA.type !== "node_failed") throw new Error("node_failed for a missing");
		expect(failedA.error).toBe("已中止");
		// Duration is measured from the FIRST attempt's start — delay included.
		expect(failedA.durationMs).toBeGreaterThan(0);
		// No post-abort execution of a, and b never started.
		expect(h.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(1);
		expect(h.executor.started).toEqual(["a"]);
	});

	it("the retry delay occupies the node's parallel slot", async () => {
		const h = harness();
		h.executor.script.a = async () => failKind("节点超时（1000ms）", "timeout");
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [] };
		const runP = h.run(graph, 1, { defaultMaxRetries: 1, retryDelayMs: 150 });
		await new Promise((r) => setTimeout(r, 20));
		// a sits out its delay holding the only slot — b must stay parked.
		expect(h.executor.started).toEqual(["a"]);
		expect(h.executor.peak).toBe(1);
		const summary = await runP;
		// a exhausted its retry (terminal failure) freed the slot → b completed.
		expect(summary.status).toBe("failed");
		expect(summary.failed).toBe(1);
		expect(summary.ok).toBe(1);
		expect(h.executor.calls.filter((c) => c.node.id === "a")).toHaveLength(2);
	});

	it("a SYNCHRONOUSLY throwing executor fails the node without wedging the run loop", async () => {
		const events: RunEvent[] = [];
		let t = 0;
		const boom: Executor = {
			run() {
				throw new Error("sync blow up");
			},
		};
		const engine = new OrchestratorEngine({ nodes: [node("a"), node("b")], edges: [] }, boom, {
			runId: "r-sync",
			now: () => ++t,
			onEvent: (e) => events.push(e),
			defaultMaxRetries: 3, // internal is never retried regardless of budget
		});
		const summary = await engine.run();
		expect(summary.status).toBe("failed");
		expect(summary.failed).toBe(2);
		const failedEv = events.find((e) => e.type === "node_failed");
		expect(failedEv && failedEv.type === "node_failed" ? failedEv.error : "").toContain("sync blow up");
		expect(events.filter((e) => e.type === "node_retry")).toHaveLength(0);
	});
});

// ============================================================================
// Precompleted seeds (rerun-failed-part: ok nodes carry over, never re-execute)
// ============================================================================

describe("precompleted seeds", () => {
	it("seeds surface as node_reused right after run_started, never touch the executor, inject downstream", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b"), edge("b", "c")] };
		const summary = await h.run(graph, 4, { precompleted: new Map([["a", { text: "old-a", fromRunId: "r-old" }]]) });
		expect(summary.status).toBe("completed");
		expect(summary.ok).toBe(3);
		expect(h.executor.started).toEqual(["b", "c"]); // a never executed
		const reused = h.events.find((e) => e.type === "node_reused");
		if (!reused || reused.type !== "node_reused") throw new Error("node_reused missing");
		expect(reused.nodeId).toBe("a");
		expect(reused.fromRunId).toBe("r-old");
		expect(reused.output.text).toBe("old-a");
		// ORDER: immediately after run_started, before any node_started.
		const types = h.events.map((e) => e.type);
		expect(types.indexOf("node_reused")).toBe(types.indexOf("run_started") + 1);
		expect(types.indexOf("node_started")).toBeGreaterThan(types.indexOf("node_reused"));
		// The seed injects into b's prompt like an ordinary completion.
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB.assembledPrompt).toContain("old-a");
	});

	it("a fully seeded graph completes without a single executor call", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };
		const summary = await h.run(graph, 4, {
			precompleted: new Map([
				["a", { text: "x", fromRunId: "r1" }],
				["b", { text: "y", fromRunId: "r1" }],
			]),
		});
		expect(summary).toEqual({ status: "completed", ok: 2, failed: 0, skipped: 0 });
		expect(h.executor.calls).toHaveLength(0);
		// Both seeds announced in graph order.
		const reused = h.events.filter((e) => e.type === "node_reused");
		expect(reused.map((r) => (r.type === "node_reused" ? r.nodeId : ""))).toEqual(["a", "b"]);
	});

	it("a seeded branch does not falsely satisfy an AND-join still waiting on a live upstream", async () => {
		const h = harness();
		const graph: GraphDef = {
			nodes: [node("s"), node("x"), node("d")],
			edges: [edge("s", "d"), edge("x", "d")],
		};
		const gate = deferred<void>();
		h.executor.script.x = hangOnGate(gate.promise);
		const runP = h.run(graph, 4, { precompleted: new Map([["s", { text: "seed-s", fromRunId: "r1" }]]) });
		await new Promise((r) => setTimeout(r, 10));
		expect(h.executor.started).toEqual(["x"]); // d NOT launched: x still open
		gate.resolve();
		await runP;
		const callD = h.executor.calls.find((c) => c.node.id === "d")!;
		expect(callD.upstream.map((u) => u.nodeId)).toEqual(["s", "x"]); // graph order
		expect(callD.assembledPrompt).toContain("seed-s");
		expect(callD.assembledPrompt).toContain("late");
	});

	it("a seeded gate never suspends — its note injects downstream like any output", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [{ id: "g", task: "task g", gate: true }, node("b")], edges: [edge("g", "b")] };
		const summary = await h.run(graph, 4, { precompleted: new Map([["g", { text: "审校通过", fromRunId: "r1" }]]) });
		expect(summary.status).toBe("completed");
		expect(h.events.some((e) => e.type === "node_awaiting")).toBe(false);
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB.assembledPrompt).toContain("审校通过");
	});
});

describe("artifacts dir wiring", () => {
	// The engine only COMPUTES paths (never touches fs) — a fake root string
	// is enough to lock the contract.
	const root = join("C:", "art");

	it("feature on: every executor call and node_started/node_reused carry <root>/<runId>/<nodeId>", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };
		const summary = await h.run(graph, 4, {
			artifactsRoot: root,
			precompleted: new Map([["a", { text: "old-a", fromRunId: "r-old" }]]),
		});
		expect(summary.status).toBe("completed");
		const callB = h.executor.calls.find((c) => c.node.id === "b")!;
		expect(callB.artifactDir).toBe(join(root, "r-test", "b"));
		const started = h.events.filter((e) => e.type === "node_started");
		for (const ev of started) {
			if (ev.type !== "node_started") continue;
			expect(ev.artifactDir).toBe(join(root, "r-test", ev.nodeId));
		}
		const reused = h.events.find((e) => e.type === "node_reused");
		if (!reused || reused.type !== "node_reused") throw new Error("node_reused missing");
		expect(reused.artifactDir).toBe(join(root, "r-test", "a"));
	});

	it("feature off (default): the field is ABSENT from events and calls — byte-identical payloads", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };
		const summary = await h.run(graph, 4, { precompleted: new Map([["a", { text: "old-a", fromRunId: "r-old" }]]) });
		expect(summary.status).toBe("completed");
		for (const ev of h.events) {
			if (ev.type === "node_started" || ev.type === "node_reused") {
				expect("artifactDir" in ev).toBe(false);
			}
		}
		for (const call of h.executor.calls) expect(call.artifactDir).toBeUndefined();
	});

	it("a Windows-reserved node id gets no artifactDir yet still runs to completion", async () => {
		const h = harness();
		const graph: GraphDef = { nodes: [node("con"), node("b")], edges: [edge("con", "b")] };
		const summary = await h.run(graph, 4, { artifactsRoot: root });
		expect(summary).toEqual({ status: "completed", ok: 2, failed: 0, skipped: 0 });
		for (const ev of h.events) {
			if (ev.type === "node_started" && ev.nodeId === "con") expect(ev.artifactDir).toBeUndefined();
			if (ev.type === "node_started" && ev.nodeId === "b") expect(ev.artifactDir).toBe(join(root, "r-test", "b"));
		}
		const callCon = h.executor.calls.find((c) => c.node.id === "con")!;
		expect(callCon.artifactDir).toBeUndefined();
	});
});

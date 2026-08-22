import { describe, expect, it } from "vitest";
import { OrchestratorEngine, type Executor, type ExecutorCall, type NodeResult } from "../src/orchestrator.ts";
import type { GraphDef, RunEvent } from "@pi-graph/shared";

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
const hangOnGate = <T>(gate: Promise<T>) => () => gate.then(() => ok("late"));
const hangOnAbort = (ctx: Ctx) =>
	new Promise<NodeResult>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));

interface Harness {
	executor: FakeExecutor;
	events: RunEvent[];
	run: (graph: GraphDef, maxParallel?: number) => Promise<{ status: string; ok: number; failed: number; skipped: number }>;
}

function harness(): Harness {
	const executor = new FakeExecutor();
	const events: RunEvent[] = [];
	let t = 0;
	const run = (graph: GraphDef, maxParallel?: number) => {
		const engine = new OrchestratorEngine(graph, executor, {
			runId: "r-test",
			maxParallel,
			now: () => ++t,
			onEvent: (e) => events.push(e),
		});
		return engine.run();
	};
	return { executor, events, run };
}

const node = (id: string, task = `task ${id}`) => ({ id, task });
const edge = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });

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

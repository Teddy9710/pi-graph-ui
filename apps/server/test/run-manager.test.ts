import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_GATE_NOTE_CHARS, RunManager, type ChatRunResult, type Planner } from "../src/run-manager.ts";
import { RunStore } from "../src/run-store.ts";
import type { Executor, ExecutorCall, NodeResult } from "../src/orchestrator.ts";
import type { PlanOutcome, RepairOutcome, RepairRequest } from "../src/planner.ts";
import { MAX_GOAL_CHARS } from "../src/planner.ts";
import { foldRunEvent, initRunState, type GraphDef, type RunEvent } from "@pi-graph/shared";

type Ctx = { onDelta: (kind: "text" | "tool", delta: string) => void; signal: AbortSignal };

const ok = (text: string): NodeResult => ({ ok: true, text });

const hangOnAbort = (ctx: Ctx) =>
	new Promise<NodeResult>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));

function fakeExecutor(script: (call: ExecutorCall, ctx: Ctx) => Promise<NodeResult>): Executor {
	return { run: script };
}

function singleNodeGraph(task = "做点事"): GraphDef {
	return { name: "test", nodes: [{ id: "a", task }], edges: [] };
}

/** Gated fake planner: emits scripted deltas, resolves when told to. */
class FakePlanner implements Planner {
	readonly goals: string[] = [];
	readonly signals: AbortSignal[] = [];
	private resolve: ((o: PlanOutcome) => void) | null = null;

	constructor(private readonly deltas: string[] = []) {}

	plan(goal: string, ctx: { onDelta: (delta: string) => void; signal: AbortSignal }): Promise<PlanOutcome> {
		this.goals.push(goal);
		this.signals.push(ctx.signal);
		for (const d of this.deltas) ctx.onDelta(d);
		return new Promise<PlanOutcome>((res) => {
			this.resolve = res;
		});
	}

	settle(outcome: PlanOutcome): void {
		this.resolve?.(outcome);
	}
}

describe("RunManager", () => {
	let dir: string;
	let store: RunStore;

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects an invalid graph with issues", () => {
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), store });
		const result = manager.start({ nodes: [{ id: "a", task: " " }], edges: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues?.length ?? 0).toBeGreaterThan(0);
		expect(manager.active).toBe(false);
	});

	it("rejects a second start while a run is active", async () => {
		const manager = new RunManager({ executor: fakeExecutor(hangOnAbort), store });
		const first = manager.start(singleNodeGraph());
		expect(first.ok).toBe(true);
		const second = manager.start(singleNodeGraph());
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error).toContain("运行");
		manager.abort();
		await vi.advanceTimersByTimeAsync(0);
	});

	it("retains and replays structure events to subscribers", async () => {
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("结果")), store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const started = manager.start(singleNodeGraph());
		expect(started.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const types = seen.map((e) => e.type);
		expect(types).toEqual(["run_started", "node_started", "node_completed", "run_finished"]);
		expect(manager.retainedEvents()).toEqual(seen);
		// Round-trip through the archive.
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0]!.status).toBe("completed");
		const runId = started.ok ? started.runId : "";
		const archived = await store.read(runId);
		expect(archived.map((e) => e.type)).toEqual(types);
	});

	it("coalesces node deltas on a 150ms window (concatenating, not latest-wins)", async () => {
		const gate = { resolve: (() => {}) as (v: NodeResult) => void };
		const gatePromise = new Promise<NodeResult>((res) => {
			gate.resolve = res;
		});
		const manager = new RunManager({
			executor: fakeExecutor(async (call, ctx) => {
				if (call.node.id !== "a") return ok("x");
				ctx.onDelta("text", "你");
				ctx.onDelta("text", "好");
				ctx.onDelta("tool", "→ bash\n");
				return gatePromise;
			}),
			store,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.start(singleNodeGraph());
		await vi.advanceTimersByTimeAsync(0);
		// Nothing flushed yet: deltas sit in the per-node buffer.
		expect(seen.filter((e) => e.type === "node_delta")).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(200);
		const deltas = seen.filter((e) => e.type === "node_delta");
		expect(deltas).toHaveLength(1);
		expect(deltas[0] && deltas[0].type === "node_delta" ? deltas[0].delta : "").toBe("你好→ bash\n");
		// Complete the node: terminal event follows the flushed delta.
		gate.resolve(ok("你好，世界"));
		await vi.advanceTimersByTimeAsync(0);
		const idxDelta = seen.findIndex((e) => e.type === "node_delta");
		const idxCompleted = seen.findIndex((e) => e.type === "node_completed");
		expect(idxDelta).toBeGreaterThan(-1);
		expect(idxDelta).toBeLessThan(idxCompleted);
	});

	it("flushes buffered deltas before node_completed even without the timer", async () => {
		const manager = new RunManager({
			executor: fakeExecutor(async (call, ctx) => {
				if (call.node.id !== "a") return ok("x");
				ctx.onDelta("text", "流式片段");
				return ok("最终文本");
			}),
			store,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.start(singleNodeGraph());
		await vi.advanceTimersByTimeAsync(0);
		const idxDelta = seen.findIndex((e) => e.type === "node_delta");
		const idxCompleted = seen.findIndex((e) => e.type === "node_completed");
		expect(seen[idxDelta] && seen[idxDelta]!.type === "node_delta" ? seen[idxDelta]!.delta : "").toBe("流式片段");
		expect(idxDelta).toBeLessThan(idxCompleted);
	});

	it("abort flushes buffers and finishes with status aborted", async () => {
		const manager = new RunManager({
			executor: fakeExecutor(async (call, ctx) => {
				if (call.node.id !== "a") return ok("x");
				ctx.onDelta("text", "半截输出");
				return hangOnAbort(ctx);
			}),
			store,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.start(singleNodeGraph());
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.abort()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const fin = seen.find((e) => e.type === "run_finished");
		expect(fin && fin.type === "run_finished" ? fin.status : "").toBe("aborted");
		// The buffered delta was flushed BEFORE the node's terminal event.
		const idxDelta = seen.findIndex((e) => e.type === "node_delta");
		const idxFailed = seen.findIndex((e) => e.type === "node_failed");
		expect(idxDelta).toBeGreaterThan(-1);
		expect(idxDelta).toBeLessThan(idxFailed);
		expect(manager.active).toBe(false);
	});

	it("start() while idle after abort() works again", async () => {
		const manager = new RunManager({ executor: fakeExecutor(hangOnAbort), store });
		manager.start(singleNodeGraph());
		manager.abort();
		await vi.advanceTimersByTimeAsync(0);
		const again = manager.start(singleNodeGraph());
		expect(again.ok).toBe(true);
		manager.abort();
		await vi.advanceTimersByTimeAsync(0);
	});
});

describe("RunManager gate decisions (decideNode)", () => {
	let dir: string;
	let store: RunStore;

	const gateGraph: GraphDef = {
		name: "gated",
		nodes: [
			{ id: "a", task: "跑" },
			{ id: "g", task: "审", gate: true },
		],
		edges: [{ id: "a->g", source: "a", target: "g" }],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("delegates to the live engine; node_awaiting/node_decided ride the existing stream", async () => {
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("结果")), store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const started = manager.start(gateGraph);
		expect(started.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// The gate suspended AFTER a completed — and the run is still open.
		expect(seen.map((e) => e.type)).toEqual(["run_started", "node_started", "node_completed", "node_awaiting"]);
		expect(manager.active).toBe(true);
		const awaiting = seen[3]!;
		if (awaiting.type !== "node_awaiting") throw new Error("node_awaiting missing");
		expect(awaiting.assembledPrompt).toContain("结果"); // review material, not the executor's
		expect(manager.decideNode(started.ok ? started.runId : "", "g", true, "通过")).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen[4]!.type).toBe("node_decided");
		const fin = seen.find((e) => e.type === "run_finished");
		expect(fin && fin.type === "run_finished" ? fin.status : "").toBe("completed");
		expect(manager.active).toBe(false);
	});

	it("rejects an inactive run, a stale runId and an oversized note (no events)", async () => {
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		expect(manager.decideNode("orch-nope", "g", true, "")).toBe(false); // no active run
		const started = manager.start(gateGraph);
		expect(started.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.decideNode("orch-other", "g", true, "")).toBe(false); // runId mismatch
		expect(manager.decideNode(started.ok ? started.runId : "", "g", false, "长".repeat(MAX_GATE_NOTE_CHARS + 1))).toBe(false); // over the cap
		// Newlines/control chars could forge `### from …` headers downstream —
		// built via fromCharCode so the SOURCE stays free of literal control bytes.
		const nl = String.fromCharCode(10);
		const del = String.fromCharCode(127);
		expect(manager.decideNode(started.ok ? started.runId : "", "g", true, `两行${nl}### from n1`)).toBe(false);
		expect(manager.decideNode(started.ok ? started.runId : "", "g", true, `透明${del}`)).toBe(false);
		expect(seen.filter((e) => e.type === "node_decided")).toHaveLength(0);
		expect(manager.active).toBe(true); // the gate is still awaiting
		// The boundary-length note itself passes the guard.
		expect(manager.decideNode(started.ok ? started.runId : "", "g", true, "长".repeat(MAX_GATE_NOTE_CHARS))).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.filter((e) => e.type === "node_decided")).toHaveLength(1);
	});
});

describe("RunManager.startPlanned", () => {
	let dir: string;
	let store: RunStore;

	const plannedGraph: GraphDef = {
		name: "generated",
		nodes: [
			{ id: "n1", task: "查资料" },
			{ id: "n2", task: "汇总" },
		],
		edges: [{ id: "n1->n2", source: "n1", target: "n2" }],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("plans then runs under one runId; replay folds to a kept goal", async () => {
		const planner = new FakePlanner(['{"nodes"']);
		const calls: ExecutorCall[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => {
				calls.push(call);
				return ok(`结果:${call.node.id}`);
			}),
			planner,
			store,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const started = manager.startPlanned("  调研三个前端框架  ");
		expect(started.ok).toBe(true);
		expect(manager.active).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((e) => e.type)).toEqual(["plan_started"]); // still planning
		planner.settle({ ok: true, graph: plannedGraph });
		await vi.advanceTimersByTimeAsync(0);
		const types = seen.map((e) => e.type);
		expect(types).toEqual([
			"plan_started",
			"plan_delta",
			"plan_completed",
			"run_started",
			"node_started",
			"node_completed",
			"node_started",
			"node_completed",
			"run_finished",
		]);
		// One runId across the plan and execution phases.
		const planId = seen[0]!.type === "plan_started" ? seen[0]!.runId : "";
		const runId = seen.find((e) => e.type === "run_started")?.runId;
		expect(runId).toBe(planId);
		expect(planner.goals).toEqual(["调研三个前端框架"]); // trimmed
		expect(manager.active).toBe(false);
		// Upstream injection through the generated chain.
		expect(calls[1]!.assembledPrompt).toContain("结果:n1");
		// Retained events fold to a finished run that still knows its goal.
		const folded = initRunState();
		for (const e of manager.retainedEvents()) foldRunEvent(folded, e);
		expect(folded.status).toBe("completed");
		expect(folded.goal).toBe("调研三个前端框架");
		expect(folded.planText).toBe('{"nodes"');
	});

	it("plan failure → plan_failed + run_finished failed, then a new run works", async () => {
		const planner = new FakePlanner();
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("目标");
		await vi.advanceTimersByTimeAsync(0);
		planner.settle({ ok: false, error: "JSON 解析失败" });
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((e) => e.type)).toEqual(["plan_started", "plan_failed", "run_finished"]);
		const fin = seen[2]!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("failed");
		expect(manager.active).toBe(false);
		// A plan-only failure is still listed in the archive (no run_started).
		const list = await store.list();
		expect(list).toHaveLength(1);
		expect(list[0]!.status).toBe("failed");
		// Restart immediately.
		const again = manager.startPlanned("再来一次");
		expect(again.ok).toBe(true);
		planner.settle({ ok: false, error: "还是失败" });
		await vi.advanceTimersByTimeAsync(0);
	});

	it("rejects a plan/graph start while planning, and bad goals", async () => {
		const planner = new FakePlanner();
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const first = manager.startPlanned("目标");
		expect(first.ok).toBe(true);
		expect(manager.startPlanned("另一个").ok).toBe(false); // busy
		expect(manager.start(singleNodeGraph()).ok).toBe(false); // busy
		planner.settle({ ok: false, error: "x" });
		await vi.advanceTimersByTimeAsync(0);
		const empty = manager.startPlanned("   ");
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error).toContain("目标不能为空");
	});

	it("without a planner configured the goal path reports it", () => {
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), store });
		const result = manager.startPlanned("目标");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("未配置规划器");
	});

	it("abort during planning: aborted run_finished, planner signal fired, late resolve ignored", async () => {
		const planner = new FakePlanner(["草稿"]);
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const started = manager.startPlanned("目标");
		expect(started.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.abort()).toBe(true);
		expect(planner.signals[0]!.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// plan_delta flushed before the terminal event; no plan_failed here.
		expect(seen.map((e) => e.type)).toEqual(["plan_started", "plan_delta", "run_finished"]);
		const fin = seen[2]!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("aborted");
		expect(manager.active).toBe(false);
		// A late planner resolution must not start an engine for the dead run.
		planner.settle({ ok: true, graph: plannedGraph });
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.filter((e) => e.type === "run_started")).toHaveLength(0);
		// …and the manager is immediately reusable.
		const again = manager.startPlanned("新目标");
		expect(again.ok).toBe(true);
		planner.settle({ ok: false, error: "收尾" });
		await vi.advanceTimersByTimeAsync(0);
		const after = seen.filter((e) => again.ok && e.runId === again.runId);
		// The reused FakePlanner replays its scripted delta on the second call.
		expect(after.map((e) => e.type)).toEqual(["plan_started", "plan_delta", "plan_failed", "run_finished"]);
	});

	it("coalesces plan deltas on the 150ms window and flushes before plan_completed", async () => {
		const planner = new FakePlanner(["第一段", "第二段"]);
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("目标");
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.filter((e) => e.type === "plan_delta")).toHaveLength(0); // buffered
		await vi.advanceTimersByTimeAsync(200);
		const deltas = seen.filter((e) => e.type === "plan_delta");
		expect(deltas).toHaveLength(1);
		expect(deltas[0]!.type === "plan_delta" ? deltas[0]!.delta : "").toBe("第一段第二段");
		planner.settle({ ok: true, graph: singleNodeGraph() });
		await vi.advanceTimersByTimeAsync(0);
		const idxDelta = seen.findIndex((e) => e.type === "plan_delta");
		const idxCompleted = seen.findIndex((e) => e.type === "plan_completed");
		expect(idxDelta).toBeGreaterThan(-1);
		expect(idxDelta).toBeLessThan(idxCompleted);
	});

	it("a planner crash is reported as plan_failed, not a hung run", async () => {
		const planner: Planner = {
			plan: () => Promise.reject(new Error("planner blew up")),
		};
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("目标");
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((e) => e.type)).toEqual(["plan_started", "plan_failed", "run_finished"]);
		expect(manager.active).toBe(false);
	});

	it("a planner that THROWS synchronously still gets a terminal event (no permanent busy)", async () => {
		// The Planner seam is open to any implementation; a sync throw after
		// planning=true must not escape startPlanned with the manager wedged.
		const planner: Planner = {
			plan: () => {
				throw new Error("sync boom");
			},
		};
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const result = manager.startPlanned("目标");
		expect(result.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((e) => e.type)).toEqual(["plan_started", "plan_failed", "run_finished"]);
		if (seen[1]!.type === "plan_failed") expect(seen[1].error).toContain("sync boom");
		expect(manager.active).toBe(false);
	});

	it("flushes buffered plan deltas BEFORE plan_failed on the crash path", async () => {
		// Crash after streaming: the coalescing buffer may still be armed when
		// the rejection lands — finishPlanning must flush it ahead of the
		// terminal events (deltas strictly before terminal, same contract as
		// node_completed).
		const planner: Planner = {
			plan: (_goal, ctx) => {
				ctx.onDelta('{"nodes": [');
				return Promise.reject(new Error("mid-stream crash"));
			},
		};
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("目标");
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((e) => e.type)).toEqual(["plan_started", "plan_delta", "plan_failed", "run_finished"]);
	});

	it("rejects a goal beyond MAX_GOAL_CHARS at the boundary (echo bounded)", async () => {
		const planner = new FakePlanner();
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const result = manager.startPlanned("长".repeat(MAX_GOAL_CHARS + 1));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("目标过长");
		expect(seen).toHaveLength(0); // nothing echoed to clients/disk
		expect(planner.goals).toHaveLength(0); // planner never spawned
		expect(manager.active).toBe(false);
	});

	it("a planner graph that fails validation is rejected defensively", async () => {
		const planner = new FakePlanner();
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner, store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("目标");
		await vi.advanceTimersByTimeAsync(0);
		// Cycle → the .then guard must catch it (a fake planner bypassed extractGraph).
		planner.settle({ ok: true, graph: { nodes: [{ id: "a", task: "x" }], edges: [{ id: "a->a", source: "a", target: "a" }] } });
		await vi.advanceTimersByTimeAsync(0);
		const failed = seen.find((e) => e.type === "plan_failed");
		expect(failed).toBeDefined();
		expect(seen.some((e) => e.type === "run_started")).toBe(false);
		expect(manager.active).toBe(false);
	});
});

describe("RunManager chat hook (onChatRunComplete)", () => {
	let dir: string;
	let store: RunStore;

	const labeledGraph: GraphDef = {
		name: "chat-plan",
		nodes: [
			{ id: "n1", task: "查资料", label: "调研" },
			{ id: "n2", task: "汇总", label: "汇总结论" },
		],
		edges: [{ id: "n1->n2", source: "n1", target: "n2" }],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("fires once on a completed chat run: trimmed goal, labeled nodes in completion order, after run_finished", async () => {
		const planner = new FakePlanner();
		const seen: RunEvent[] = [];
		const results: ChatRunResult[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => ok(`结果:${call.node.id}`)),
			planner,
			store,
			onChatRunComplete: (result) => {
				// Timing contract: the card already flipped 完成 (run_finished is
				// the LAST broadcast) before the hook hands results to the caller.
				const last = seen[seen.length - 1];
				if (last?.type !== "run_finished") throw new Error("hook ran before run_finished broadcast");
				results.push(result);
			},
		});
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("  调研并汇总  ", { chat: true });
		await vi.advanceTimersByTimeAsync(0);
		planner.settle({ ok: true, graph: labeledGraph });
		await vi.advanceTimersByTimeAsync(0);
		expect(results).toHaveLength(1);
		expect(results[0]!.goal).toBe("调研并汇总"); // trimmed
		expect(results[0]!.nodes).toEqual([
			{ nodeId: "n1", label: "调研", text: "结果:n1" },
			{ nodeId: "n2", label: "汇总结论", text: "结果:n2" },
		]);
		expect(results[0]!.runId).toBe(seen.find((e) => e.type === "run_started")?.runId);
		expect(manager.active).toBe(false);
	});

	it("a decided gate counts toward ok but never enters nodes (chip ≠ injection is by design)", async () => {
		const planner = new FakePlanner();
		const results: ChatRunResult[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => ok(`结果:${call.node.id}`)),
			planner,
			store,
			onChatRunComplete: (r) => results.push(r),
		});
		const gated: GraphDef = {
			name: "chat-plan-gated",
			nodes: [
				{ id: "n1", task: "写入", label: "写入文件" },
				{ id: "g1", task: "审", label: "放行审校", gate: true },
				{ id: "n2", task: "读回", label: "读回文件" },
			],
			edges: [
				{ id: "n1->g1", source: "n1", target: "g1" },
				{ id: "g1->n2", source: "g1", target: "n2" },
			],
		};
		const started = manager.startPlanned("目标", { chat: true });
		await vi.advanceTimersByTimeAsync(0);
		planner.settle({ ok: true, graph: gated });
		await vi.advanceTimersByTimeAsync(0);
		// The run is parked on the gate — no terminal event, no hook yet.
		expect(results).toHaveLength(0);
		expect(manager.active).toBe(true);
		expect(manager.decideNode(started.ok ? started.runId : "", "g1", true, "已核对")).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(results).toHaveLength(1);
		// Gates emit node_awaiting/node_decided, never node_completed — so the
		// injection sees only the executor's two outputs (the note reaches the
		// synthesis transitively, inside n2's `### from g1` section), while the
		// run summary counts all three (decided gate = ok). GATE-19 contract.
		expect(results[0]!.nodes).toEqual([
			{ nodeId: "n1", label: "写入文件", text: "结果:n1" },
			{ nodeId: "n2", label: "读回文件", text: "结果:n2" },
		]);
		expect(results[0]!.nodes.some((n) => n.nodeId === "g1")).toBe(false);
	});

	it("never fires without the chat flag", async () => {
		const planner = new FakePlanner();
		const results: ChatRunResult[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async () => ok("x")),
			planner,
			store,
			onChatRunComplete: (r) => results.push(r),
		});
		manager.startPlanned("目标");
		await vi.advanceTimersByTimeAsync(0);
		planner.settle({ ok: true, graph: labeledGraph });
		await vi.advanceTimersByTimeAsync(0);
		expect(results).toHaveLength(0);
	});

	it("never fires on node failure, abort, or plan failure", async () => {
		// node failure
		{
			const planner = new FakePlanner();
			const results: ChatRunResult[] = [];
			const manager = new RunManager({
				executor: fakeExecutor(async () => ({ ok: false, text: "", error: "boom" })),
				planner,
				store,
				onChatRunComplete: (r) => results.push(r),
			});
			manager.startPlanned("目标", { chat: true });
			await vi.advanceTimersByTimeAsync(0);
			planner.settle({ ok: true, graph: labeledGraph });
			await vi.advanceTimersByTimeAsync(0);
			expect(results).toHaveLength(0);
		}
		// abort mid-run
		{
			const planner = new FakePlanner();
			const results: ChatRunResult[] = [];
			const manager = new RunManager({
				executor: fakeExecutor(hangOnAbort),
				planner,
				store,
				onChatRunComplete: (r) => results.push(r),
			});
			manager.startPlanned("目标", { chat: true });
			await vi.advanceTimersByTimeAsync(0);
			planner.settle({ ok: true, graph: labeledGraph });
			await vi.advanceTimersByTimeAsync(0);
			manager.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(results).toHaveLength(0);
		}
		// plan failure
		{
			const planner = new FakePlanner();
			const results: ChatRunResult[] = [];
			const manager = new RunManager({
				executor: fakeExecutor(async () => ok("x")),
				planner,
				store,
				onChatRunComplete: (r) => results.push(r),
			});
			manager.startPlanned("目标", { chat: true });
			await vi.advanceTimersByTimeAsync(0);
			planner.settle({ ok: false, error: "解析失败" });
			await vi.advanceTimersByTimeAsync(0);
			expect(results).toHaveLength(0);
		}
	});

	it("a throwing hook does not wedge the manager or fake a failed summary", async () => {
		const planner = new FakePlanner();
		const seen: RunEvent[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async () => ok("x")),
			planner,
			store,
			onChatRunComplete: () => {
				throw new Error("bridge died");
			},
		});
		manager.subscribe((e) => seen.push(e));
		manager.startPlanned("目标", { chat: true });
		await vi.advanceTimersByTimeAsync(0);
		planner.settle({ ok: true, graph: labeledGraph });
		await vi.advanceTimersByTimeAsync(0);
		// Exactly one terminal event — the real completed one; the throw must
		// not surface as a synthetic run_finished(failed).
		const finished = seen.filter((e) => e.type === "run_finished");
		expect(finished).toHaveLength(1);
		expect(finished[0]!.type === "run_finished" ? finished[0]!.status : "").toBe("completed");
		expect(manager.active).toBe(false);
		// The next run proceeds normally.
		const again = manager.startPlanned("再来", { chat: true });
		expect(again.ok).toBe(true);
		manager.abort();
		await vi.advanceTimersByTimeAsync(0);
	});
});

describe("RunStore", () => {
	it("read() rejects ids outside the allowlist", async () => {
		const store = new RunStore(mkdtempSync(join(tmpdir(), "runs-test-")));
		expect(await store.read("../evil")).toEqual([]);
		expect(await store.read("a/b")).toEqual([]);
		expect(await store.read("missing-id")).toEqual([]);
		rmSync(store.dir, { recursive: true, force: true });
	});
});

// ============================================================================
// 一键重跑失败部分 (rerunFailed)
// ============================================================================

describe("RunManager.rerunFailed", () => {
	let dir: string;
	let store: RunStore;

	/** a → b → c; b fails on its FIRST execution only. */
	const chainGraph: GraphDef = {
		name: "chain",
		nodes: [
			{ id: "a", task: "跑a" },
			{ id: "b", task: "跑b" },
			{ id: "c", task: "跑c" },
		],
		edges: [
			{ id: "a->b", source: "a", target: "b" },
			{ id: "b->c", source: "b", target: "c" },
		],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("seeds ok nodes as node_reused and re-executes the failed part under a NEW runId", async () => {
		const calls: ExecutorCall[] = [];
		let bCalls = 0;
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => {
				calls.push(call);
				if (call.node.id === "b" && ++bCalls === 1) return { ok: false, text: "", error: "boom" };
				return ok(`结果:${call.node.id}`);
			}),
			store,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const first = manager.start(chainGraph);
		expect(first.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// Run 1: a ok, b failed, c skipped.
		expect(seen.some((e) => e.type === "node_failed" && e.nodeId === "b")).toBe(true);

		const rerun = await manager.rerunFailed(first.ok ? first.runId : "");
		expect(rerun.ok).toBe(true);
		if (rerun.ok) expect(rerun.runId).not.toBe(first.runId);
		await vi.advanceTimersByTimeAsync(0);

		const rerunEvents = seen.filter((e) => rerun.ok && e.runId === rerun.runId);
		expect(rerunEvents.map((e) => e.type)).toEqual([
			"run_started",
			"node_reused", // a — right after run_started
			"node_started", // b — re-executed
			"node_completed",
			"node_started", // c — unblocked by the fixed b
			"node_completed",
			"run_finished",
		]);
		const reused = rerunEvents[1]!;
		if (reused.type !== "node_reused") throw new Error("node_reused missing");
		expect(reused.nodeId).toBe("a");
		expect(reused.fromRunId).toBe(first.runId);
		expect(reused.output.text).toBe("结果:a");
		// a ran exactly ONCE across both runs (never re-executed in run 2).
		expect(calls.filter((c) => c.node.id === "a")).toHaveLength(1);
		// b's re-execution injects a's OLD output (the seed).
		const callB2 = calls.filter((c) => c.node.id === "b")[1]!;
		expect(callB2.assembledPrompt).toContain("结果:a");
		const fin = rerunEvents.at(-1)!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("completed");
		expect(manager.active).toBe(false);
		// The full replay folds to the rerun (fresh state from repair-free events).
		const folded = initRunState();
		for (const e of manager.retainedEvents()) foldRunEvent(folded, e);
		expect(folded.status).toBe("completed");
		expect(folded.nodes.a?.reusedFrom).toBe(first.runId);
	});

	it("falls back to the RunStore archive once retention has moved on", async () => {
		const calls: ExecutorCall[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => {
				calls.push(call);
				return call.node.id === "b" ? { ok: false, text: "", error: "boom" } : ok(`结果:${call.node.id}`);
			}),
			store,
		});
		const first = manager.start(chainGraph);
		await vi.advanceTimersByTimeAsync(0);
		// An unrelated run claims retention (a node the chain never mentions).
		const other = manager.start({ name: "other", nodes: [{ id: "z", task: "无关" }], edges: [] });
		expect(other.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const rerun = await manager.rerunFailed(first.ok ? first.runId : "");
		expect(rerun.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// a was seeded from the ARCHIVE, not from memory.
		const reused = (rerun.ok ? manager.retainedEvents() : []).find(
			(e) => e.type === "node_reused" && e.runId === (rerun.ok ? rerun.runId : ""),
		);
		if (!reused || reused.type !== "node_reused") throw new Error("node_reused missing");
		expect(reused.nodeId).toBe("a");
		expect(reused.fromRunId).toBe(first.runId);
		expect(calls.filter((c) => c.node.id === "a")).toHaveLength(1); // still never re-executed
	});

	it("an approved gate's note seeds verbatim (the gate never re-awaits)", async () => {
		const gated: GraphDef = {
			name: "gated",
			nodes: [
				{ id: "a", task: "跑" },
				{ id: "g", task: "审", gate: true },
			],
			edges: [{ id: "a->g", source: "a", target: "g" }],
		};
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("结果:a")), store });
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const first = manager.start(gated);
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.decideNode(first.ok ? first.runId : "", "g", true, "  审校通过  ")).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const rerun = await manager.rerunFailed(first.ok ? first.runId : "");
		expect(rerun.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const rerunEvents = seen.filter((e) => rerun.ok && e.runId === rerun.runId);
		// All nodes were ok — the rerun is a pure replay.
		expect(rerunEvents.map((e) => e.type)).toEqual(["run_started", "node_reused", "node_reused", "run_finished"]);
		const reusedG = rerunEvents.find((e) => e.type === "node_reused" && e.nodeId === "g");
		if (!reusedG || reusedG.type !== "node_reused") throw new Error("node_reused for g missing");
		expect(reusedG.output.text).toBe("审校通过"); // trimmed note
		expect(rerunEvents.some((e) => e.type === "node_awaiting")).toBe(false);
	});

	it("rejects an unknown id, a busy manager, and a run without run_finished", async () => {
		const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), store });
		const missing = await manager.rerunFailed("orch-missing");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("找不到");

		const busyManager = new RunManager({ executor: fakeExecutor(hangOnAbort), store });
		busyManager.start(singleNodeGraph());
		const busy = await busyManager.rerunFailed("whatever");
		expect(busy.ok).toBe(false);
		if (!busy.ok) expect(busy.error).toContain("运行");
		busyManager.abort();
		await vi.advanceTimersByTimeAsync(0);

		// Hand-write an archive with run_started but no run_finished.
		const store2 = store;
		store2.append({ type: "run_started", runId: "orch-torn1", startedAt: 1, graph: singleNodeGraph() });
		const torn = await manager.rerunFailed("orch-torn1");
		expect(torn.ok).toBe(false);
		if (!torn.ok) expect(torn.error).toContain("尚未结束");
	});
});

// ============================================================================
// AI 修复失败节点 (startRepair)
// ============================================================================

/** Fake planner exposing the optional rewriteTask seam: scripted deltas + manual settle. */
class FakeRepairPlanner implements Planner {
	readonly requests: RepairRequest[] = [];
	readonly signals: AbortSignal[] = [];
	private resolve: ((o: RepairOutcome) => void) | null = null;

	constructor(private readonly deltas: string[] = []) {}

	plan(): Promise<PlanOutcome> {
		return Promise.resolve({ ok: false, error: "plan not used" });
	}

	rewriteTask(req: RepairRequest, ctx: { onDelta: (delta: string) => void; signal: AbortSignal }): Promise<RepairOutcome> {
		this.requests.push(req);
		this.signals.push(ctx.signal);
		for (const d of this.deltas) ctx.onDelta(d);
		return new Promise<RepairOutcome>((res) => {
			this.resolve = res;
		});
	}

	settle(outcome: RepairOutcome): void {
		this.resolve?.(outcome);
	}
}

describe("RunManager.startRepair", () => {
	let dir: string;
	let store: RunStore;

	const pairGraph: GraphDef = {
		name: "pair",
		nodes: [
			{ id: "a", task: "跑a" },
			{ id: "b", task: "跑b", model: "old/model", tools: ["read"] },
		],
		edges: [{ id: "a->b", source: "a", target: "b" }],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Run the pair once: a ok, b failed (only on its FIRST execution). */
	async function failedPair(overrides: { planner?: Planner } = {}) {
		const planner = new FakeRepairPlanner(['{"task"']);
		const calls: ExecutorCall[] = [];
		let bCalls = 0;
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => {
				calls.push(call);
				if (call.node.id === "b" && ++bCalls === 1) return { ok: false, text: "", error: "模型太弱" };
				return ok(`结果:${call.node.id}`);
			}),
			planner: overrides.planner ?? planner,
			store,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const first = manager.start(structuredClone(pairGraph));
		await vi.advanceTimersByTimeAsync(0);
		return { manager, planner, calls, seen, fromRunId: first.ok ? first.runId : "" };
	}

	it("rewrites the failed node and re-runs it with the other outputs seeded (same runId)", async () => {
		const f = await failedPair();
		const repair = await f.manager.startRepair(f.fromRunId, "b");
		expect(repair.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// The rewriter saw the failure context: error + upstream output + config.
		expect(f.planner.requests).toHaveLength(1);
		const req = f.planner.requests[0]!;
		expect(req.nodeId).toBe("b");
		expect(req.task).toBe("跑b");
		expect(req.error).toBe("模型太弱");
		expect(req.upstream).toEqual([{ nodeId: "a", text: "结果:a" }]);
		expect(req.model).toBe("old/model");
		expect(req.tools).toEqual(["read"]);

		f.planner.settle({ ok: true, task: "新任务：分两步跑", model: "new/model" });
		await vi.advanceTimersByTimeAsync(0);
		const repairEvents = f.seen.filter((e) => repair.ok && e.runId === repair.runId);
		expect(repairEvents.map((e) => e.type)).toEqual([
			"repair_started",
			"repair_delta",
			"repair_completed",
			"run_started",
			"node_reused", // a
			"node_started", // b with the REWRITTEN task
			"node_completed",
			"run_finished",
		]);
		// Same runId across the repair and execution phases (startPlanned mirror).
		expect(repairEvents[0]!.runId).toBe(repairEvents.find((e) => e.type === "run_started")!.runId);
		const completed = repairEvents.find((e) => e.type === "repair_completed");
		if (!completed || completed.type !== "repair_completed") throw new Error("repair_completed missing");
		expect(completed.task).toBe("新任务：分两步跑");
		expect(completed.model).toBe("new/model");
		// The executed graph carries the override; a's seed injected into b.
		const callB2 = f.calls.filter((c) => c.node.id === "b")[1]!;
		expect(callB2.node.task).toBe("新任务：分两步跑");
		expect(callB2.node.model).toBe("new/model");
		expect(callB2.assembledPrompt).toContain("结果:a");
		const fin = repairEvents.at(-1)!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("completed");
		expect(f.manager.active).toBe(false);
		// Replay folds the repair preview + the run.
		const folded = initRunState();
		for (const e of f.manager.retainedEvents()) foldRunEvent(folded, e);
		expect(folded.status).toBe("completed");
		expect(folded.nodes.b?.output).toBe("结果:b");
	});

	it("an override WITHOUT model/tools DELETES them from the node (the rewrite is authoritative)", async () => {
		const f = await failedPair();
		const repair = await f.manager.startRepair(f.fromRunId, "b");
		await vi.advanceTimersByTimeAsync(0);
		f.planner.settle({ ok: true, task: "裸任务" });
		await vi.advanceTimersByTimeAsync(0);
		const callB2 = f.calls.filter((c) => c.node.id === "b")[1]!;
		expect(callB2.node.task).toBe("裸任务");
		expect(callB2.node.model).toBeUndefined(); // deleted, not carried over
		expect(callB2.node.tools).toBeUndefined();
	});

	it("repair failure → repair_failed + terminal run_finished, manager reusable", async () => {
		const f = await failedPair();
		const repair = await f.manager.startRepair(f.fromRunId, "b");
		await vi.advanceTimersByTimeAsync(0);
		f.planner.settle({ ok: false, error: "修不好" });
		await vi.advanceTimersByTimeAsync(0);
		const repairEvents = f.seen.filter((e) => repair.ok && e.runId === repair.runId);
		expect(repairEvents.map((e) => e.type)).toEqual(["repair_started", "repair_delta", "repair_failed", "run_finished"]);
		const fin = repairEvents.at(-1)!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("failed");
		expect(f.manager.active).toBe(false);
		// A repair-only failure is still archived as a run.
		const list = await store.list();
		expect(list.some((m) => m.id === (repair.ok ? repair.runId : "") && m.status === "failed")).toBe(true);
		// Immediately reusable.
		const again = f.manager.start(singleNodeGraph());
		expect(again.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
	});

	it("a synchronously throwing rewriter gets a terminal event (no permanent busy)", async () => {
		const planner: Planner = {
			plan: () => Promise.resolve({ ok: false, error: "unused" }),
			rewriteTask: () => {
				throw new Error("sync boom");
			},
		};
		const f = await failedPair({ planner });
		const repair = await f.manager.startRepair(f.fromRunId, "b");
		expect(repair.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const repairEvents = f.seen.filter((e) => repair.ok && e.runId === repair.runId);
		expect(repairEvents.map((e) => e.type)).toEqual(["repair_started", "repair_failed", "run_finished"]);
		if (repairEvents[1]!.type === "repair_failed") expect(repairEvents[1].error).toContain("sync boom");
		expect(f.manager.active).toBe(false);
	});

	it("guards: no rewriter seam, gate target, unknown node, no failure record, busy", async () => {
		// No rewriteTask on the planner.
		{
			const planner = new FakePlanner();
			const f = await failedPair({ planner });
			const r = await f.manager.startRepair(f.fromRunId, "b");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain("未配置修复器");
		}
		// Gate target.
		{
			const manager = new RunManager({ executor: fakeExecutor(async () => ok("x")), planner: new FakeRepairPlanner(), store });
			const gated: GraphDef = {
				name: "g",
				nodes: [
					{ id: "a", task: "跑" },
					{ id: "g", task: "审", gate: true },
				],
				edges: [{ id: "a->g", source: "a", target: "g" }],
			};
			const first = manager.start(gated);
			await vi.advanceTimersByTimeAsync(0);
			// The run parks on the awaiting gate — settle it (abort) so the
			// manager is idle and the repair path reaches the gate check.
			manager.abort();
			await vi.advanceTimersByTimeAsync(0);
			const r = await manager.startRepair(first.ok ? first.runId : "", "g");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain("门控");
		}
		// Unknown node / non-failed node.
		{
			const f = await failedPair();
			const unknown = await f.manager.startRepair(f.fromRunId, "zzz");
			expect(unknown.ok).toBe(false);
			const notFailed = await f.manager.startRepair(f.fromRunId, "a");
			expect(notFailed.ok).toBe(false);
			if (!notFailed.ok) expect(notFailed.error).toContain("失败记录");
		}
		// Busy.
		{
			const f = await failedPair();
			const hanging = f.manager.start(singleNodeGraph());
			// singleNodeGraph's node "a" is still the fake executor's ok path —
			// it completes instantly, so use a hanging executor manager instead.
			expect(hanging.ok).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			const busyManager = new RunManager({ executor: fakeExecutor(hangOnAbort), planner: new FakeRepairPlanner(), store });
			busyManager.start(singleNodeGraph());
			const busy = await busyManager.startRepair("whatever", "a");
			expect(busy.ok).toBe(false);
			if (!busy.ok) expect(busy.error).toContain("运行");
			busyManager.abort();
			await vi.advanceTimersByTimeAsync(0);
		}
	});

	it("abort during the repair: aborted run_finished, rewriter signal fired, late settle ignored", async () => {
		const f = await failedPair();
		const repair = await f.manager.startRepair(f.fromRunId, "b");
		await vi.advanceTimersByTimeAsync(0);
		expect(f.manager.abort()).toBe(true);
		expect(f.planner.signals[0]!.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const repairEvents = f.seen.filter((e) => repair.ok && e.runId === repair.runId);
		expect(repairEvents.map((e) => e.type)).toEqual(["repair_started", "repair_delta", "run_finished"]);
		const fin = repairEvents.at(-1)!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("aborted");
		expect(f.manager.active).toBe(false);
		// A late rewriter resolution must not start an engine for the dead run.
		f.planner.settle({ ok: true, task: "迟到" });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.seen.filter((e) => e.type === "run_started").length).toBe(1); // only the source run
	});
});

describe("RunManager artifacts (output.md 归档)", () => {
	let dir: string;
	let store: RunStore;
	let artRoot: string;

	const chainGraph: GraphDef = {
		name: "chain",
		nodes: [
			{ id: "a", task: "跑a", label: "A 节点" },
			{ id: "b", task: "跑b" },
		],
		edges: [{ id: "a->b", source: "a", target: "b" }],
	};

	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "runs-test-"));
		artRoot = mkdtempSync(join(tmpdir(), "art-test-"));
		store = new RunStore(dir);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
		rmSync(artRoot, { recursive: true, force: true });
	});

	it("writes per-node output.md for completed nodes; subscriber events unchanged", async () => {
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => ok(`结果:${call.node.id}`)),
			store,
			artifactsRoot: artRoot,
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const started = manager.start(chainGraph);
		expect(started.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.map((e) => e.type)).toEqual([
			"run_started",
			"node_started",
			"node_completed",
			"node_started",
			"node_completed",
			"run_finished",
		]);
		const runId = started.ok ? started.runId : "";
		const fileA = readFileSync(join(artRoot, runId, "a", "output.md"), "utf8");
		expect(fileA).toContain("runId: " + runId);
		expect(fileA).toContain("nodeId: a");
		expect(fileA).toContain("label: A 节点");
		expect(fileA.endsWith("\n\n---\n\n结果:a\n")).toBe(true);
		expect(existsSync(join(artRoot, runId, "b", "output.md"))).toBe(true);
	});

	it("executor calls carry artifactDir (the engine computed it from the same root)", async () => {
		const calls: ExecutorCall[] = [];
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => {
				calls.push(call);
				return ok(`结果:${call.node.id}`);
			}),
			store,
			artifactsRoot: artRoot,
		});
		const started = manager.start(chainGraph);
		await vi.advanceTimersByTimeAsync(0);
		const runId = started.ok ? started.runId : "";
		expect(calls.map((c) => c.artifactDir)).toEqual([join(artRoot, runId, "a"), join(artRoot, runId, "b")]);
	});

	it("rerunFailed archives seed outputs into the NEW run's dir with fromRunId headers", async () => {
		let bCalls = 0;
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => {
				if (call.node.id === "b" && ++bCalls === 1) return { ok: false, text: "", error: "boom" };
				return ok(`结果:${call.node.id}`);
			}),
			store,
			artifactsRoot: artRoot,
		});
		const first = manager.start(chainGraph);
		await vi.advanceTimersByTimeAsync(0);
		const rerun = await manager.rerunFailed(first.ok ? first.runId : "");
		expect(rerun.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		const newRunId = rerun.ok ? rerun.runId : "";
		const fileA = readFileSync(join(artRoot, newRunId, "a", "output.md"), "utf8");
		expect(fileA).toContain(`runId: ${newRunId}`);
		expect(fileA).toContain(`fromRunId: ${first.ok ? first.runId : ""}`);
		expect(fileA.endsWith("\n\n---\n\n结果:a\n")).toBe(true);
		// b re-executed → its own output.md in the new dir too.
		expect(existsSync(join(artRoot, newRunId, "b", "output.md"))).toBe(true);
	});

	it("feature off (no artifactsRoot): nothing is ever created under a scratch root", async () => {
		const manager = new RunManager({ executor: fakeExecutor(async (call) => ok("x")), store });
		manager.start(singleNodeGraph());
		await vi.advanceTimersByTimeAsync(0);
		expect(readdirSync(artRoot)).toEqual([]);
	});

	it("an unwritable artifacts root never fails the run (per-run latch)", async () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => ok("结果")),
			store,
			artifactsRoot: join(blocker, "under", "a", "file"),
		});
		const seen: RunEvent[] = [];
		manager.subscribe((e) => seen.push(e));
		const started = manager.start(singleNodeGraph());
		await vi.advanceTimersByTimeAsync(0);
		const fin = seen.at(-1)!;
		expect(fin.type === "run_finished" ? fin.status : "").toBe("completed");
		expect(manager.active).toBe(false);
	});

	it("per-run latch skips archiving for later nodes after the first write fails", async () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const manager = new RunManager({
			executor: fakeExecutor(async (call) => ok(`结果:${call.node.id}`)),
			store,
			artifactsRoot: join(blocker, "under", "a", "file"),
		});
		const started = manager.start(chainGraph);
		expect(started.ok).toBe(true);
		const runId = started.ok ? started.runId : "";
		manager.subscribe((e) => {
			if (e.type === "node_completed" && e.nodeId === "a") {
				// Remove the blocker before node b runs; a writable root would let
				// b's archive write succeed unless the per-run latch is honored.
				unlinkSync(blocker);
			}
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.active).toBe(false);
		// Node a's archive write failed → no output.md.
		expect(existsSync(join(blocker, "under", "a", "file", runId, "a", "output.md"))).toBe(false);
		// Node b executed, but the latch should have suppressed archiving.
		expect(existsSync(join(blocker, "under", "a", "file", runId, "b", "output.md"))).toBe(false);
	});
});

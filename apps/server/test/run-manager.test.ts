import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "../src/run-manager.ts";
import { RunStore } from "../src/run-store.ts";
import type { Executor, ExecutorCall, NodeResult } from "../src/orchestrator.ts";
import type { GraphDef, RunEvent } from "@pi-graph/shared";

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

describe("RunStore", () => {
	it("read() rejects ids outside the allowlist", async () => {
		const store = new RunStore(mkdtempSync(join(tmpdir(), "runs-test-")));
		expect(await store.read("../evil")).toEqual([]);
		expect(await store.read("a/b")).toEqual([]);
		expect(await store.read("missing-id")).toEqual([]);
		rmSync(store.dir, { recursive: true, force: true });
	});
});

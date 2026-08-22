/**
 * RunManager - owns the (single) active orchestration run.
 *
 * Bridges OrchestratorEngine events out to WebSocket subscribers and the
 * RunStore archive. node_delta events are coalesced per node on a 150ms
 * window — the buffer CONCATENATES (never latest-wins) so the client preview
 * stays a faithful tail of the node's stream. Structure events flush their
 * node's pending buffer first, preserving delta-before-completion ordering.
 *
 * Retention: events of the last run stay in memory until the next run starts,
 * so a browser refresh reconnects and replays them from hello.
 */

import { validateGraph, zeroNodeUsage, type GraphDef, type GraphValidationIssue, type RunEvent } from "@pi-graph/shared";
import { OrchestratorEngine, type Executor } from "./orchestrator.ts";
import { RunStore } from "./run-store.ts";

export type StartResult = { ok: true; runId: string } | { ok: false; error: string; issues?: GraphValidationIssue[] };

export interface RunManagerOptions {
	executor: Executor;
	maxParallel?: number;
	store?: RunStore;
	/** Delta coalescing window (ms). Default 150. */
	deltaIntervalMs?: number;
	now?: () => number;
}

export class RunManager {
	private readonly executor: Executor;
	private readonly maxParallel: number | undefined;
	private readonly store: RunStore | null;
	private readonly deltaIntervalMs: number;
	private readonly now: () => number;

	private engine: OrchestratorEngine | null = null;
	private currentRunId: string | null = null;
	private retained: RunEvent[] = [];
	private readonly listeners = new Set<(event: RunEvent) => void>();
	/** nodeId → buffered delta text, WITH the runId it arrived under (a
	 *  post-settle tail must never be re-stamped with the next run's id). */
	private readonly deltaBuffers = new Map<string, { runId: string; text: string }>();
	private readonly deltaTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private runSeq = 0;

	constructor(options: RunManagerOptions) {
		this.executor = options.executor;
		this.maxParallel = options.maxParallel;
		this.store = options.store ?? null;
		this.deltaIntervalMs = options.deltaIntervalMs ?? 150;
		this.now = options.now ?? Date.now;
	}

	get active(): boolean {
		return this.engine !== null;
	}

	/** Start a run; rejects (returns issues) when busy or the graph is invalid. */
	start(graph: GraphDef): StartResult {
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };
		const issues = validateGraph(graph);
		if (issues.length > 0) return { ok: false, error: "图校验未通过", issues };
		const runId = `orch-${this.now().toString(36)}-${++this.runSeq}`;
		// New run: drop the previous run's retention, drain any stale buffers.
		this.retained = [];
		this.flushAllDeltas();
		this.currentRunId = runId;
		const engine = new OrchestratorEngine(graph, this.executor, {
			runId,
			maxParallel: this.maxParallel,
			now: this.now,
			onEvent: (event) => this.retain(event),
		});
		this.engine = engine;
		void engine
			.run()
			.catch((err: Error) => {
				// The engine validates defensively; reaching here means a bug.
				// Emit a synthetic terminal event so clients don't hang on "running".
				console.error("[run-manager] engine crashed:", err);
				this.flushAllDeltas();
				this.publish({
					type: "run_finished",
					runId,
					finishedAt: this.now(),
					status: "failed",
					ok: 0,
					failed: 0,
					skipped: 0,
					usage: zeroNodeUsage(),
				});
			})
			.finally(() => {
				// Flush BEFORE clearing run bookkeeping — a late tail still
				// carries its original runId (see deltaBuffers).
				this.flushAllDeltas();
				this.engine = null;
				this.currentRunId = null;
			});
		return { ok: true, runId };
	}

	/** Abort the active run (no-op when idle). */
	abort(): boolean {
		if (!this.engine) return false;
		this.engine.abort();
		return true;
	}

	subscribe(listener: (event: RunEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	retainedEvents(): RunEvent[] {
		return [...this.retained];
	}

	// ------------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------------

	private retain(event: RunEvent): void {
		if (event.type === "node_delta") {
			// Coalesce: append to the node's buffer; a timer flushes it whole.
			const prev = this.deltaBuffers.get(event.nodeId);
			this.deltaBuffers.set(event.nodeId, {
				runId: prev?.runId ?? event.runId,
				text: (prev?.text ?? "") + event.delta,
			});
			if (!this.deltaTimers.has(event.nodeId)) {
				const timer = setTimeout(() => this.flushNode(event.nodeId), this.deltaIntervalMs);
				// Never keep the process alive just for a coalescing flush.
				(timer as { unref?: () => void }).unref?.();
				this.deltaTimers.set(event.nodeId, timer);
			}
			return;
		}
		// Structure events flush pending deltas first so clients observe
		// deltas strictly before the node's terminal event.
		if (event.type === "node_completed" || event.type === "node_failed" || event.type === "node_skipped") {
			this.flushNode(event.nodeId);
		} else if (event.type === "run_finished") {
			this.flushAllDeltas();
		}
		this.publish(event);
	}

	private flushNode(nodeId: string): void {
		const timer = this.deltaTimers.get(nodeId);
		if (timer) {
			clearTimeout(timer);
			this.deltaTimers.delete(nodeId);
		}
		const buffer = this.deltaBuffers.get(nodeId);
		if (!buffer) return;
		this.deltaBuffers.delete(nodeId);
		this.publish({ type: "node_delta", runId: buffer.runId, nodeId, kind: "text", delta: buffer.text });
	}

	private flushAllDeltas(): void {
		for (const nodeId of [...this.deltaBuffers.keys()]) this.flushNode(nodeId);
	}

	private publish(event: RunEvent): void {
		this.retained.push(event);
		this.store?.append(event);
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error("[run-manager] listener threw:", err);
			}
		}
	}
}

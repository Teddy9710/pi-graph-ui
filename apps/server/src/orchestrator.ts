/**
 * OrchestratorEngine - deterministic DAG scheduler for graph orchestration.
 *
 * A node runs when ALL its upstreams completed ok (AND-join). Upstream
 * failures skip the entire downstream closure transitively — immediately,
 * without waiting for sibling upstreams still in flight. The Executor is
 * injected so the scheduler is unit-testable without spawning pi.
 *
 * Event semantics (RunEvent union in shared/orchestration.ts):
 * - the ENGINE assembles prompts (shared assemblePrompt) so tests can assert
 *   upstream injection through the Executor seam;
 * - node_delta events forward executor onDelta callbacks verbatim;
 * - run_finished.status: "aborted" > "failed" (any node_failed) > "completed".
 */

import {
	addNodeUsage,
	assemblePrompt,
	zeroNodeUsage,
	type GraphDef,
	type NodeDef,
	type NodeRunStatus,
	type NodeUsage,
	type RunEvent,
	type RunStatus,
	type UpstreamInput,
} from "@pi-graph/shared";

// ============================================================================
// Executor seam
// ============================================================================

export interface NodeResult {
	ok: boolean;
	text: string;
	stopReason?: string;
	model?: string;
	usage?: NodeUsage;
	error?: string;
}

export interface ExecutorCall {
	node: NodeDef;
	/** Task + injected upstream outputs (what actually gets sent to pi). */
	assembledPrompt: string;
	upstream: UpstreamInput[];
}

export interface Executor {
	run(
		call: ExecutorCall,
		ctx: { onDelta: (kind: "text" | "tool", delta: string) => void; signal: AbortSignal },
	): Promise<NodeResult>;
}

export interface EngineOptions {
	runId: string;
	/** Max concurrently running nodes. Default 4. */
	maxParallel?: number;
	/** Injectable clock for deterministic tests. Default Date.now. */
	now?: () => number;
	onEvent: (event: RunEvent) => void;
}

// ============================================================================
// Engine
// ============================================================================

export class OrchestratorEngine {
	private readonly graph: GraphDef;
	private readonly executor: Executor;
	private readonly runId: string;
	private readonly maxParallel: number;
	private readonly now: () => number;
	private readonly emit: (event: RunEvent) => void;

	private readonly nodeById = new Map<string, NodeDef>();
	private readonly upstreams = new Map<string, string[]>();
	private readonly downstreams = new Map<string, string[]>();
	/** Unresolved upstream count per node. */
	private readonly remaining = new Map<string, number>();
	private readonly status = new Map<string, NodeRunStatus>();
	private readonly outputs = new Map<string, string>();
	/** Edge relation labels keyed `${source}->${target}` (first edge wins on
	 *  duplicates — validation already rejects them, this is just defensive). */
	private readonly edgeLabels = new Map<string, string>();
	private readonly inflight = new Map<string, Promise<void>>();
	private ready: string[] = [];

	private readonly abortCtl = new AbortController();
	private aborted = false;
	private finished = false;
	private ok = 0;
	private failed = 0;
	private skipped = 0;
	private usage = zeroNodeUsage();

	constructor(graph: GraphDef, executor: Executor, options: EngineOptions) {
		this.graph = graph;
		this.executor = executor;
		this.runId = options.runId;
		this.maxParallel = Math.max(1, options.maxParallel ?? 4);
		this.now = options.now ?? Date.now;
		this.emit = options.onEvent;
		this.build();
	}

	/** Structural + cycle validation (callers run shared validateGraph first). */
	validate(): void {
		// Kahn on a copy of the indegrees: nodes that never reach 0 are on/behind a cycle.
		const indegree = new Map(this.remaining);
		const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
		const peeled = new Set<string>();
		while (queue.length > 0) {
			const id = queue.shift()!;
			peeled.add(id);
			for (const next of this.downstreams.get(id) ?? []) {
				const d = (indegree.get(next) ?? 1) - 1;
				indegree.set(next, d);
				if (d === 0) queue.push(next);
			}
		}
		if (peeled.size < this.nodeById.size) {
			const cyclic = [...this.nodeById.keys()].filter((id) => !peeled.has(id));
			throw new Error(`graph has a cycle involving: ${cyclic.join(", ")}`);
		}
	}

	/** Drive the graph to completion; resolves with the run summary. */
	async run(): Promise<{ status: RunStatus; ok: number; failed: number; skipped: number }> {
		this.emit({ type: "run_started", runId: this.runId, startedAt: this.now(), graph: this.graph });
		while (true) {
			while (this.ready.length > 0 && this.inflight.size < this.maxParallel) {
				const id = this.ready.shift()!;
				if (this.status.get(id) !== "pending") continue; // pruned by failure propagation
				this.launch(id);
			}
			if (this.inflight.size === 0) break;
			await Promise.race(this.inflight.values());
		}
		const status: RunStatus = this.aborted ? "aborted" : this.failed > 0 ? "failed" : "completed";
		this.finished = true;
		this.emit({
			type: "run_finished",
			runId: this.runId,
			finishedAt: this.now(),
			status,
			ok: this.ok,
			failed: this.failed,
			skipped: this.skipped,
			usage: { ...this.usage },
		});
		return { status, ok: this.ok, failed: this.failed, skipped: this.skipped };
	}

	/** Abort: pending nodes are skipped, queued never launch, inflight fail via signal. */
	abort(): void {
		if (this.finished) return;
		this.aborted = true;
		this.abortCtl.abort();
		this.ready = [];
		for (const n of this.graph.nodes) {
			if (this.status.get(n.id) !== "pending") continue;
			this.status.set(n.id, "skipped");
			this.skipped++;
			this.emit({ type: "node_skipped", runId: this.runId, nodeId: n.id, reason: "run aborted" });
		}
	}

	// ------------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------------

	/** Populate adjacency + indegrees, validate, seed the ready queue. */
	private build(): void {
		for (const n of this.graph.nodes) {
			if (this.nodeById.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
			this.nodeById.set(n.id, n);
			this.upstreams.set(n.id, []);
			this.downstreams.set(n.id, []);
			this.remaining.set(n.id, 0);
			this.status.set(n.id, "pending");
		}
		for (const e of this.graph.edges) {
			if (!this.nodeById.has(e.source)) throw new Error(`edge ${e.id}: unknown source`);
			if (!this.nodeById.has(e.target)) throw new Error(`edge ${e.id}: unknown target`);
			if (e.source === e.target) throw new Error(`edge ${e.id}: self-loop`);
			this.downstreams.get(e.source)!.push(e.target);
			this.upstreams.get(e.target)!.push(e.source);
			const pairKey = `${e.source}->${e.target}`;
			if (e.label && !this.edgeLabels.has(pairKey)) this.edgeLabels.set(pairKey, e.label);
			this.remaining.set(e.target, this.remaining.get(e.target)! + 1);
		}
		this.validate();
		// Seed the ready queue in graph order for deterministic scheduling.
		this.ready = this.graph.nodes.filter((n) => this.remaining.get(n.id) === 0).map((n) => n.id);
	}

	private launch(id: string): void {
		const node = this.nodeById.get(id)!;
		const upstream: UpstreamInput[] = (this.upstreams.get(id) ?? []).map((uid) => ({
			nodeId: uid,
			text: this.outputs.get(uid) ?? "",
			// The edge's relation label tells the executor WHY this input
			// arrives (semantic edge), not just from whom.
			label: this.edgeLabels.get(`${uid}->${id}`),
		}));
		const assembledPrompt = assemblePrompt(node, upstream);
		const startedAt = this.now();
		this.status.set(id, "running");
		this.emit({ type: "node_started", runId: this.runId, nodeId: id, startedAt, assembledPrompt });
		let promise: Promise<void>;
		try {
			promise = this.executor
				.run(
					{ node, assembledPrompt, upstream },
					{
						onDelta: (kind, delta) => {
							this.emit({ type: "node_delta", runId: this.runId, nodeId: id, kind, delta });
						},
						signal: this.abortCtl.signal,
					},
				)
				.then(
					(r) => {
						if (r.ok) this.complete(id, startedAt, r);
						else this.fail(id, startedAt, r.error ?? `stopReason: ${r.stopReason ?? "unknown"}`);
					},
					(err: Error) => this.fail(id, startedAt, err.message),
				)
				.then(() => {
					this.inflight.delete(id);
				});
		} catch (err) {
			// Executor violated the async contract (threw synchronously).
			this.fail(id, startedAt, (err as Error).message);
			return;
		}
		this.inflight.set(id, promise);
	}

	private complete(id: string, startedAt: number, r: NodeResult): void {
		this.outputs.set(id, r.text);
		this.status.set(id, "ok");
		this.ok++;
		if (r.usage) addNodeUsage(this.usage, r.usage);
		this.emit({
			type: "node_completed",
			runId: this.runId,
			nodeId: id,
			endedAt: this.now(),
			durationMs: Math.max(0, this.now() - startedAt),
			output: { text: r.text, stopReason: r.stopReason ?? "stop", model: r.model, usage: r.usage ?? zeroNodeUsage() },
		});
		for (const d of this.downstreams.get(id) ?? []) {
			if (this.status.get(d) !== "pending") continue; // already skipped / running
			const rem = this.remaining.get(d)! - 1;
			this.remaining.set(d, rem);
			if (rem === 0) this.ready.push(d);
		}
	}

	private fail(id: string, startedAt: number, error: string): void {
		this.status.set(id, "error");
		this.failed++;
		this.emit({
			type: "node_failed",
			runId: this.runId,
			nodeId: id,
			endedAt: this.now(),
			durationMs: Math.max(0, this.now() - startedAt),
			error,
		});
		this.skipClosure(id, `upstream failed: ${id}`);
	}

	/** BFS the downstream closure; every still-pending node is skipped now. */
	private skipClosure(fromId: string, reason: string): void {
		const queue = [...(this.downstreams.get(fromId) ?? [])];
		while (queue.length > 0) {
			const d = queue.shift()!;
			if (this.status.get(d) !== "pending") continue;
			this.status.set(d, "skipped");
			this.skipped++;
			this.emit({ type: "node_skipped", runId: this.runId, nodeId: d, reason });
			queue.push(...(this.downstreams.get(d) ?? []));
		}
	}
}

/**
 * OrchestratorEngine - deterministic DAG scheduler for graph orchestration.
 *
 * A node runs when ALL its upstreams completed ok (AND-join). Upstream
 * failures skip the entire downstream closure transitively — immediately,
 * without waiting for sibling upstreams still in flight. The Executor is
 * injected so the scheduler is unit-testable without spawning pi.
 *
 * Gate nodes (NodeDef.gate) never touch the Executor: they suspend the run as
 * "awaiting" (node_awaiting) until a human decides them via decideNode —
 * approval unlocks downstream exactly like a completion (the note becomes the
 * node's output), rejection propagates like a failure. "awaiting" is NOT a
 * terminal state: the run loop parks until every gate is decided or aborted.
 *
 * Event semantics (RunEvent union in shared/orchestration.ts):
 * - the ENGINE assembles prompts (shared assemblePrompt) so tests can assert
 *   upstream injection through the Executor seam;
 * - node_delta events forward executor onDelta callbacks verbatim;
 * - gate decisions bracket as node_awaiting → node_decided (never a
 *   node_started/node_completed pair — the executor was never involved);
 * - run_finished.status: "aborted" > "failed" (any node_failed) > "completed".
 */

import {
	addNodeUsage,
	assemblePrompt,
	zeroNodeUsage,
	type EdgeType,
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
	/** Executor attempt count (>1 = quality gate salvaged this node). */
	attempts?: number;
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
	/** Edge TYPE + note keyed `${source}->${target}` (first wins on
	 *  duplicates — validation already rejects them, this is just defensive). */
	private readonly edgeTypes = new Map<string, EdgeType>();
	private readonly edgeLabels = new Map<string, string>();
	private readonly inflight = new Map<string, Promise<void>>();
	private ready: string[] = [];
	/** Gate nodes parked on a human decision (subset of status==="awaiting"). */
	private readonly awaiting = new Set<string>();
	/** When each gate entered awaiting — node_decided.durationMs is measured from here. */
	private readonly awaitingSince = new Map<string, number>();
	/** Run-loop resolvers parked in Promise.race while gates are open. */
	private gateWaiters: (() => void)[] = [];

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
			// Slot-blocked NORMAL nodes park here (order preserved) so the scan
			// can continue past them — a ready gate queued behind blocked work
			// must suspend immediately, not wait for an executor slot.
			const parked: string[] = [];
			while (this.ready.length > 0) {
				const id = this.ready.shift()!;
				if (this.status.get(id) !== "pending") continue; // pruned by failure propagation
				// Gates suspend for a human decision instead of running — they
				// never reach the Executor and never occupy a parallel slot, so
				// they drain out of the queue regardless of slot pressure.
				if (this.nodeById.get(id)!.gate === true) {
					this.suspend(id);
					continue;
				}
				if (this.inflight.size >= this.maxParallel) {
					parked.push(id); // slot busy — park, keep scanning for gates
					continue;
				}
				this.launch(id);
			}
			if (parked.length > 0) this.ready.unshift(...parked);
			// "awaiting" is not terminal: only a decision (decideNode) or an
			// abort closes a gate, so open gates join the race and keep the
			// run from finishing without them.
			const wakeups: Promise<unknown>[] = [...this.inflight.values()];
			if (this.awaiting.size > 0) wakeups.push(this.gateSignal());
			if (wakeups.length === 0) break;
			await Promise.race(wakeups);
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
			const st = this.status.get(n.id);
			if (st === "pending") {
				this.status.set(n.id, "skipped");
				this.skipped++;
				this.emit({ type: "node_skipped", runId: this.runId, nodeId: n.id, reason: "run aborted" });
				continue;
			}
			if (st !== "awaiting") continue;
			// An undecided gate settles the way a running node does on abort:
			// it FAILS (the executor's 已中止 error) rather than being skipped,
			// so the parked run loop may finish and clients see a terminal node.
			const startedAt = this.awaitingSince.get(n.id) ?? this.now();
			this.awaiting.delete(n.id);
			this.awaitingSince.delete(n.id);
			this.status.set(n.id, "error");
			this.failed++;
			this.emit({
				type: "node_failed",
				runId: this.runId,
				nodeId: n.id,
				endedAt: this.now(),
				durationMs: Math.max(0, this.now() - startedAt),
				error: "已中止",
			});
		}
		this.wake();
	}

	/**
	 * Decide an awaiting gate (approve/reject). Valid ONLY while the node is
	 * awaiting — anything else (unknown id, already decided, aborted, run
	 * finished) is a silent no-op returning false with no event.
	 * Approval: the trimmed note (default （已批准）) becomes the node's output
	 * and unlocks downstream like an ordinary completion. Rejection: the node
	 * fails and the downstream closure is skipped with the standard reason.
	 */
	decideNode(nodeId: string, approved: boolean, note: string): boolean {
		if (this.status.get(nodeId) !== "awaiting") return false;
		const startedAt = this.awaitingSince.get(nodeId) ?? this.now();
		this.awaiting.delete(nodeId);
		this.awaitingSince.delete(nodeId);
		const endedAt = this.now();
		this.emit({
			type: "node_decided",
			runId: this.runId,
			nodeId,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			approved,
			note,
		});
		if (approved) {
			this.outputs.set(nodeId, note.trim() || "（已批准）");
			this.status.set(nodeId, "ok");
			this.ok++;
			this.settleDownstream(nodeId);
		} else {
			this.status.set(nodeId, "error");
			this.failed++;
			this.skipClosure(nodeId, `upstream failed: ${nodeId}`);
		}
		this.wake();
		return true;
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
			if (e.type && !this.edgeTypes.has(pairKey)) this.edgeTypes.set(pairKey, e.type);
			if (e.label && !this.edgeLabels.has(pairKey)) this.edgeLabels.set(pairKey, e.label);
			this.remaining.set(e.target, this.remaining.get(e.target)! + 1);
		}
		this.validate();
		// Seed the ready queue in graph order for deterministic scheduling.
		this.ready = this.graph.nodes.filter((n) => this.remaining.get(n.id) === 0).map((n) => n.id);
	}

	private launch(id: string): void {
		const node = this.nodeById.get(id)!;
		const upstream = this.upstreamInputs(id);
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

	/** Suspend a ready gate as awaiting a human decision (no executor call). */
	private suspend(id: string): void {
		const node = this.nodeById.get(id)!;
		const assembledPrompt = assemblePrompt(node, this.upstreamInputs(id));
		const startedAt = this.now();
		this.status.set(id, "awaiting");
		this.awaiting.add(id);
		this.awaitingSince.set(id, startedAt);
		// The assembled prompt is the review material: the human sees exactly
		// what this gate would pass downstream (task + upstream injection).
		this.emit({ type: "node_awaiting", runId: this.runId, nodeId: id, startedAt, assembledPrompt });
	}

	private gateSignal(): Promise<void> {
		return new Promise<void>((resolve) => this.gateWaiters.push(resolve));
	}

	/** A gate was decided (or aborted) — unpark the run loop. */
	private wake(): void {
		const waiters = this.gateWaiters;
		this.gateWaiters = [];
		for (const w of waiters) w();
	}

	/** Snapshot of one node's upstream contributions (prompt material). */
	private upstreamInputs(id: string): UpstreamInput[] {
		return (this.upstreams.get(id) ?? []).map((uid) => ({
			nodeId: uid,
			text: this.outputs.get(uid) ?? "",
			// The edge's TYPE (+ optional note) tells the executor HOW this
			// input is meant to be used, not just from whom it arrives.
			type: this.edgeTypes.get(`${uid}->${id}`),
			label: this.edgeLabels.get(`${uid}->${id}`),
			// The upstream node's own injection budget, when it set one.
			capBytes: this.nodeById.get(uid)?.outputCapBytes,
		}));
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
			output: {
				text: r.text,
				stopReason: r.stopReason ?? "stop",
				model: r.model,
				usage: r.usage ?? zeroNodeUsage(),
				...(r.attempts !== undefined ? { attempts: r.attempts } : {}),
			},
		});
		this.settleDownstream(id);
	}

	/** A node reached ok: decrement downstream indegrees, queue newly ready ones. */
	private settleDownstream(id: string): void {
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

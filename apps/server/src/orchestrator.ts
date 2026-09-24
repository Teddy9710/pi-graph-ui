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
 * - retryable failures (timeout/process/model) re-execute the node under
 *   node_retry events — an intermediate attempt NEVER emits node_failed, so
 *   fold counters and the terminal verdict stay exact; carried-over outputs
 *   (rerun-failed-part) surface as node_reused right after run_started and
 *   never touch the Executor;
 * - run_finished.status: "aborted" > "failed" (any node_failed) > "completed".
 */

import {
	addNodeUsage,
	assemblePrompt,
	MAX_NODE_RETRIES,
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
import { setTimeoutUnref } from "./infra/timer-unref.ts";
import { nodeArtifactsDir } from "./artifacts.ts";

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
	/**
	 * Machine-readable failure class for the ENGINE's retry policy. The engine
	 * retries timeout/process/model only; config/aborted/internal (and an
	 * ABSENT kind — old executors, adversarial results) are never retried.
	 */
	kind?: "timeout" | "process" | "model" | "config" | "aborted" | "internal";
}

export interface ExecutorCall {
	node: NodeDef;
	/** Task + injected upstream outputs (what actually gets sent to pi). */
	assembledPrompt: string;
	upstream: UpstreamInput[];
	/**
	 * This node's per-run artifacts dir (absolute). Used as the subprocess
	 * cwd when node.workdir is absent (the executor mkdir's it); ignored
	 * otherwise. undefined = artifacts feature off.
	 */
	artifactDir?: string;
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
	/**
	 * Engine-level auto-retry budget for RETRYABLE failures (timeout/process/
	 * model), used when a node has no maxRetries of its own. Default 0 — the
	 * product default (ORCH_NODE_MAX_RETRIES) is applied by main.ts, keeping
	 * bare-engine callers (tests) at the pre-retry behavior.
	 */
	defaultMaxRetries?: number;
	/** Delay between retry attempts (ms). Default 0 (immediate re-execution). */
	retryDelayMs?: number;
	/**
	 * Outputs carried over from a previous run (rerun-failed-part): each node
	 * present here is marked ok up front, injects downstream like an ordinary
	 * completion, never touches the Executor, and surfaces as ONE node_reused
	 * event right after run_started.
	 */
	precompleted?: ReadonlyMap<string, { text: string; fromRunId: string }>;
	/**
	 * Artifacts root (e.g. ~/.pi-graph-ui/artifacts). When set, every
	 * executed/reused node gets <root>/<runId>/<nodeId>/: the subprocess cwd
	 * for workdir-less nodes (the executor mkdir's it) and the output.md
	 * archive location. undefined = feature off — events and executor calls
	 * stay byte-identical to the pre-feature behavior.
	 */
	artifactsRoot?: string;
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
	private readonly defaultMaxRetries: number;
	private readonly retryDelayMs: number;
	private readonly precompleted: ReadonlyMap<string, { text: string; fromRunId: string }> | undefined;
	private readonly artifactsRoot: string | undefined;

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
	/** Seed nodes (id → the run their output came from) for node_reused events. */
	private readonly seededFrom = new Map<string, string>();
	/**
	 * Nodes sitting out their inter-attempt delay: abort must settle them the
	 * way it settles an awaiting gate (the executor's abort signal can't reach
	 * a node that isn't executing).
	 */
	private readonly retryDelays = new Map<string, { startedAt: number; cancel: () => void }>();
	private ready: string[] = [];
	/** Gate nodes parked on a human decision (subset of status==="awaiting"). */
	private readonly awaiting = new Set<string>();
	/** When each gate entered awaiting — node_decided.durationMs is measured from here. */
	private readonly awaitingSince = new Map<string, number>();
	/** Gate-wakeup signal: ONE resettable promise. A per-iteration resolver
	 *  queue would accumulate dead closures whenever Promise.race was settled
	 *  by an inflight node instead of a gate decision — long runs with an open
	 *  gate grew one dead resolver per ordinary node completion. */
	private gateWait: Promise<void> | null = null;
	private gateResolve: (() => void) | null = null;

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
		this.defaultMaxRetries = Math.max(0, options.defaultMaxRetries ?? 0);
		this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
		this.precompleted = options.precompleted;
		this.artifactsRoot = options.artifactsRoot;
		this.build();
	}

	/**
	 * This node's per-run artifacts dir. undefined when the feature is off OR
	 * the id can't be a directory name (Windows reserved device name) — that
	 * node silently keeps the pre-feature behavior; the run never fails.
	 */
	private artifactDirFor(nodeId: string): string | undefined {
		return this.artifactsRoot ? (nodeArtifactsDir(this.artifactsRoot, this.runId, nodeId) ?? undefined) : undefined;
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
		// Resume seeding: one node_reused per carried-over node, graph order,
		// immediately after run_started — clients (and the archive) see WHAT
		// was reused before any execution begins. Seeds never emit
		// node_started/node_completed in THIS run.
		if (this.seededFrom.size > 0) {
			for (const n of this.graph.nodes) {
				const fromRunId = this.seededFrom.get(n.id);
				if (fromRunId === undefined) continue;
				const artifactDir = this.artifactDirFor(n.id);
				this.emit({
					type: "node_reused",
					runId: this.runId,
					nodeId: n.id,
					fromRunId,
					output: { text: this.outputs.get(n.id) ?? "" },
					...(artifactDir ? { artifactDir } : {}),
				});
			}
		}
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
			const delay = this.retryDelays.get(n.id);
			if (delay) {
				// A node waiting out its inter-attempt delay is "running" but
				// owns no executor the abort signal could reach — settle it the
				// way an awaiting gate settles (FAIL, not skip), measured from
				// the FIRST attempt's start. cancel() wakes the drive loop,
				// whose status guard then bows out without a second settle.
				delay.cancel();
				this.fail(n.id, delay.startedAt, "已中止");
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
		// Precompleted seeds are marked BEFORE the ready queue is seeded (so the
		// status!=="pending" filter below excludes seed roots), but their
		// downstream settles AFTER it (settleDownstream PUSHes into this.ready —
		// an earlier push would be wiped by the assignment below).
		this.markPrecompleted();
		// Seed the ready queue in graph order for deterministic scheduling.
		this.ready = this.graph.nodes
			.filter((n) => this.remaining.get(n.id) === 0 && this.status.get(n.id) === "pending")
			.map((n) => n.id);
		this.settlePrecompleted();
	}

	/** Phase 1 of seeding: mark seed nodes ok + record their outputs. */
	private markPrecompleted(): void {
		if (!this.precompleted) return;
		for (const n of this.graph.nodes) {
			const seed = this.precompleted.get(n.id);
			if (!seed) continue;
			this.status.set(n.id, "ok");
			this.outputs.set(n.id, seed.text);
			this.seededFrom.set(n.id, seed.fromRunId);
			this.ok++;
		}
	}

	/** Phase 2 of seeding: seeds settle their downstream exactly like ordinary
	 *  completions (minus the events — run_started is followed by one
	 *  node_reused per seed instead). */
	private settlePrecompleted(): void {
		for (const id of this.seededFrom.keys()) this.settleDownstream(id);
	}

	private launch(id: string): void {
		const promise = this.drive(id);
		// drive's synchronous prefix can already have settled the node (an
		// executor that throws synchronously fails it before the first await) —
		// tracking an already-resolved promise would strand a permanent inflight
		// entry and wedge the run loop, so only track the node while live.
		if (this.status.get(id) === "running" || this.retryDelays.has(id)) this.inflight.set(id, promise);
	}

	/**
	 * Execute one node to its terminal state (ok / error), retrying RETRYABLE
	 * failures (timeout / process / model) up to the node's budget. Each
	 * attempt re-assembles the prompt and runs a FRESH executor.run — a fresh
	 * full timeoutMs budget (unlike the quality gate's salvage, which shares
	 * one wall clock). The inter-attempt delay OCCUPIES the parallel slot: the
	 * node is logically running throughout, so maxParallel still bounds real
	 * work. durationMs is measured from the FIRST attempt's start, delay
	 * included. Intermediate attempts emit node_retry — never node_failed —
	 * so fold counters and the terminal verdict stay exact.
	 */
	private async drive(id: string): Promise<void> {
		try {
			const node = this.nodeById.get(id)!;
			const maxAttempts = (node.maxRetries ?? this.defaultMaxRetries) + 1;
			const firstStartedAt = this.now();
			const artifactDir = this.artifactDirFor(id);
			this.status.set(id, "running");
			this.emit({
				type: "node_started",
				runId: this.runId,
				nodeId: id,
				startedAt: firstStartedAt,
				assembledPrompt: assemblePrompt(node, this.upstreamInputs(id)),
				...(artifactDir ? { artifactDir } : {}),
			});
			for (let attempt = 1; ; attempt++) {
				const upstream = this.upstreamInputs(id);
				let result: NodeResult;
				try {
					result = await this.executor.run(
						{ node, assembledPrompt: assemblePrompt(node, upstream), upstream, ...(artifactDir ? { artifactDir } : {}) },
						{
							onDelta: (kind, delta) => {
								this.emit({ type: "node_delta", runId: this.runId, nodeId: id, kind, delta });
							},
							signal: this.abortCtl.signal,
						},
					);
				} catch (err) {
					// Executor violated the async contract (threw synchronously):
					// internal — retrying the same broken executor cannot help.
					result = { ok: false, text: "", error: (err as Error).message, kind: "internal" };
				}
				if (result.ok) {
					this.complete(id, firstStartedAt, result);
					return;
				}
				const kind = result.kind ?? "internal";
				const error = result.error ?? `stopReason: ${result.stopReason ?? "unknown"}`;
				if ((kind === "timeout" || kind === "process" || kind === "model") && attempt < maxAttempts && !this.aborted) {
					this.emit({
						type: "node_retry",
						runId: this.runId,
						nodeId: id,
						attempt: attempt + 1,
						maxAttempts,
						error,
						retryInMs: this.retryDelayMs,
					});
					await this.delayRetry(id, firstStartedAt);
					// abort() settles delay-waiting nodes itself (cancel + fail);
					// a node no longer running must not execute another attempt.
					if (this.status.get(id) !== "running") return;
					continue;
				}
				this.fail(id, firstStartedAt, error);
				return;
			}
		} finally {
			this.inflight.delete(id);
		}
	}

	/**
	 * Wait out the inter-attempt delay, tracked in retryDelays so abort() can
	 * settle a delay-waiting node (the executor's abort signal can't reach a
	 * node that isn't executing). startedAt is the node's FIRST attempt start —
	 * abort's fail measures duration from there, delay included.
	 */
	private delayRetry(id: string, firstStartedAt: number): Promise<void> {
		if (this.retryDelayMs <= 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const timer = setTimeoutUnref(() => {
				this.retryDelays.delete(id);
				resolve();
			}, this.retryDelayMs);
			this.retryDelays.set(id, {
				startedAt: firstStartedAt,
				cancel: () => {
					clearTimeout(timer);
					this.retryDelays.delete(id);
					resolve();
				},
			});
		});
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

	/** The current gate signal, created lazily and reused by every run-loop
	 *  iteration until wake() consumes it (parallel waiters share it fine —
	 *  a promise resolves for ALL its awaiters). */
	private gateSignal(): Promise<void> {
		if (!this.gateWait) this.gateWait = new Promise<void>((resolve) => (this.gateResolve = resolve));
		return this.gateWait;
	}

	/** A gate was decided (or aborted) — unpark the run loop and re-arm. */
	private wake(): void {
		const resolve = this.gateResolve;
		this.gateWait = null;
		this.gateResolve = null;
		resolve?.();
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

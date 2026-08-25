/**
 * RunManager - owns the (single) active orchestration run.
 *
 * Two entry paths share one run lifecycle:
 *  - start(graph): the editor's hand-composed graph runs directly;
 *  - startPlanned(goal): a planner instance first decomposes the goal into a
 *    graph (plan_* events, same runId), then the engine takes over seamlessly.
 *
 * Bridges events out to WebSocket subscribers and the RunStore archive.
 * node_delta and plan_delta events are coalesced on a 150ms window — buffers
 * CONCATENATE (never latest-wins) so client previews stay faithful tails.
 * Structure events flush their pending buffer first, preserving
 * delta-before-completion ordering.
 *
 * Retention: events of the last run stay in memory until the next run starts,
 * so a browser refresh reconnects and replays them from hello.
 */

import {
	validateGraph,
	zeroNodeUsage,
	type GraphDef,
	type GraphValidationIssue,
	type OrchResultNode,
	type RunEvent,
} from "@pi-graph/shared";
import { OrchestratorEngine, type Executor } from "./orchestrator.ts";
import { MAX_GOAL_CHARS, type PlanOutcome } from "./planner.ts";
import { RunStore } from "./run-store.ts";

export type StartResult = { ok: true; runId: string } | { ok: false; error: string; issues?: GraphValidationIssue[] };

/** What the chat-complete hook receives: the goal + per-node outputs
 *  (labels from the run graph) in completion order. */
export interface ChatRunResult {
	runId: string;
	goal: string;
	nodes: OrchResultNode[];
}

/** The planner seam RunManager drives (PiPlanner in production, fakes in tests). */
export interface Planner {
	plan(goal: string, ctx: { onDelta: (delta: string) => void; signal: AbortSignal }): Promise<PlanOutcome>;
}

export interface RunManagerOptions {
	executor: Executor;
	/** Enables startPlanned; without it the goal path reports 未配置规划器. */
	planner?: Planner;
	maxParallel?: number;
	store?: RunStore;
	/** Delta coalescing window (ms). Default 150. */
	deltaIntervalMs?: number;
	now?: () => number;
	/** Fired ONCE when a chat-flagged planned run completes successfully
	 *  (main.ts injects the compiled results into the session agent).
	 *  Failed/aborted runs and planner failures never fire it. */
	onChatRunComplete?: (result: ChatRunResult) => void;
}

export class RunManager {
	private readonly executor: Executor;
	private readonly planner: Planner | null;
	private readonly maxParallel: number | undefined;
	private readonly store: RunStore | null;
	private readonly deltaIntervalMs: number;
	private readonly now: () => number;
	private readonly onChatRunComplete: ((result: ChatRunResult) => void) | undefined;

	private engine: OrchestratorEngine | null = null;
	private planning = false;
	private plannerAbort: AbortController | null = null;
	private currentRunId: string | null = null;
	private retained: RunEvent[] = [];
	private readonly listeners = new Set<(event: RunEvent) => void>();
	/** nodeId → buffered delta text, WITH the runId it arrived under (a
	 *  post-settle tail must never be re-stamped with the next run's id). */
	private readonly deltaBuffers = new Map<string, { runId: string; text: string }>();
	private readonly deltaTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private planBuffer: { runId: string; text: string } | null = null;
	private planTimer: ReturnType<typeof setTimeout> | null = null;
	private runSeq = 0;

	constructor(options: RunManagerOptions) {
		this.executor = options.executor;
		this.planner = options.planner ?? null;
		this.maxParallel = options.maxParallel;
		this.store = options.store ?? null;
		this.deltaIntervalMs = options.deltaIntervalMs ?? 150;
		this.now = options.now ?? Date.now;
		this.onChatRunComplete = options.onChatRunComplete;
	}

	get active(): boolean {
		return this.engine !== null || this.planning;
	}

	/** Start a run; rejects (returns issues) when busy or the graph is invalid. */
	start(graph: GraphDef): StartResult {
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };
		const issues = validateGraph(graph);
		if (issues.length > 0) return { ok: false, error: "图校验未通过", issues };
		const runId = this.nextRunId();
		this.launchEngine(graph, runId);
		return { ok: true, runId };
	}

	/**
	 * Plan a goal into a graph, then execute it under the SAME runId — clients
	 * see plan_started → plan_delta* → plan_completed → run_started → …
	 * opts.chat marks a chat-first run: on completion the onChatRunComplete
	 * hook fires with the compiled node outputs for session-agent injection.
	 */
	startPlanned(goal: string, opts?: { chat?: boolean }): StartResult {
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };
		if (!this.planner) return { ok: false, error: "服务器未配置规划器" };
		const planner = this.planner; // narrowed for the closures below
		const trimmed = goal.trim();
		if (!trimmed) return { ok: false, error: "目标不能为空" };
		// The goal echoes into plan_started (clients, retention, archive) —
		// bound it here rather than letting the planner's prompt cap be the
		// only limit on a WS-supplied string.
		if (trimmed.length > MAX_GOAL_CHARS) {
			return { ok: false, error: `目标过长（超过 ${MAX_GOAL_CHARS} 字符）` };
		}
		const runId = this.nextRunId();
		this.planning = true;
		const abort = new AbortController();
		this.plannerAbort = abort;
		this.publish({ type: "plan_started", runId, goal: trimmed, startedAt: this.now() });

		// plan() runs SYNCHRONOUSLY up to its first await (early deltas land
		// before any abort can interleave); a Planner that throws synchronously
		// (the seam is open to any implementation) must not escape with
		// planning=true wedged and no terminal event.
		let planned: Promise<PlanOutcome>;
		try {
			planned = planner.plan(trimmed, {
				onDelta: (delta) => this.retainPlanDelta(runId, delta),
				signal: abort.signal,
			});
		} catch (err) {
			console.error("[run-manager] planner threw synchronously:", err);
			this.finishPlanning(runId, `规划器异常: ${(err as Error).message}`);
			return { ok: true, runId };
		}
		planned
			.then((outcome) => {
				// Aborted (or superseded): run_finished already told the story;
				// late planner output must not touch the next run's state.
				if (!this.planning) return;
				this.flushPlanDelta();
				if (outcome.ok && validateGraph(outcome.graph).length === 0) {
					this.publish({ type: "plan_completed", runId, graph: outcome.graph });
					this.clearPlanning();
					this.launchEngine(outcome.graph, runId, opts?.chat ? { goal: trimmed } : undefined); // run_started continues the same run
					return;
				}
				const error = outcome.ok ? "规划器返回了无效的图" : outcome.error;
				this.finishPlanning(runId, error);
			})
			.catch((err: Error) => {
				console.error("[run-manager] planner crashed:", err);
				if (this.planning) this.finishPlanning(runId, `规划器异常: ${err.message}`);
			});
		return { ok: true, runId };
	}

	/** Abort the active run/planning phase (no-op when idle). */
	abort(): boolean {
		if (this.plannerAbort) {
			const runId = this.currentRunId;
			this.plannerAbort.abort();
			this.clearPlanning();
			this.flushPlanDelta();
			if (runId) {
				this.publish({
					type: "run_finished",
					runId,
					finishedAt: this.now(),
					status: "aborted",
					ok: 0,
					failed: 0,
					skipped: 0,
					usage: zeroNodeUsage(),
				});
			}
			return true;
		}
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

	/** Fresh runId + reset retention and any stale delta buffers. */
	private nextRunId(): string {
		const runId = `orch-${this.now().toString(36)}-${++this.runSeq}`;
		// New run: drop the previous run's retention, drain any stale buffers.
		this.retained = [];
		this.flushAllDeltas();
		this.flushPlanDelta();
		this.currentRunId = runId;
		return runId;
	}

	/** Build + run the engine for a validated graph (shared by both paths).
	 *  `chat` requests the chat-complete hook for planned chat-first runs. */
	private launchEngine(graph: GraphDef, runId: string, chat?: { goal: string }): void {
		const engine = new OrchestratorEngine(graph, this.executor, {
			runId,
			maxParallel: this.maxParallel,
			now: this.now,
			onEvent: (event) => this.retain(event),
		});
		this.engine = engine;
		void engine
			.run()
			.then((summary) => {
				// Timing guarantees: run_finished was published synchronously
				// INSIDE run() (clients flip the card to 完成 before injection
				// begins), and .finally below runs AFTER this .then — engine
				// bookkeeping is still set, so the runId can never be stale.
				if (chat && summary.status === "completed") this.fireChatComplete(runId, chat.goal);
			})
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
	}

	private clearPlanning(): void {
		this.planning = false;
		this.plannerAbort = null;
	}

	/**
	 * Compile the completed run's node outputs and hand them to the chat hook.
	 * Retention still holds THIS run's events (cleared only when the next run
	 * starts); node labels come from the run_started graph, outputs from
	 * node_completed events in completion order.
	 */
	private fireChatComplete(runId: string, goal: string): void {
		const runStarted = this.retained.find(
			(e): e is Extract<RunEvent, { type: "run_started" }> => e.type === "run_started" && e.runId === runId,
		);
		const labelById = new Map<string, string>();
		if (runStarted) {
			for (const node of runStarted.graph.nodes) {
				if (node.label) labelById.set(node.id, node.label);
			}
		}
		const nodes: OrchResultNode[] = [];
		for (const e of this.retained) {
			if (e.type === "node_completed" && e.runId === runId) {
				nodes.push({ nodeId: e.nodeId, label: labelById.get(e.nodeId), text: e.output.text });
			}
		}
		if (nodes.length === 0) return;
		// Hook failures must not poison the run lifecycle (a throw here would
		// otherwise land in the .catch below and emit a bogus failed summary).
		try {
			this.onChatRunComplete?.({ runId, goal, nodes });
		} catch (err) {
			console.error("[run-manager] chat-complete hook threw:", err);
		}
	}

	/** plan_failed + a terminal run_finished (planning counts as a run). */
	private finishPlanning(runId: string, error: string): void {
		// Deltas strictly before the terminal events — the .catch path (planner
		// crash) reaches here with the buffer possibly still armed.
		this.flushPlanDelta();
		this.publish({ type: "plan_failed", runId, error });
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
		this.clearPlanning();
		this.currentRunId = null;
	}

	private retainPlanDelta(runId: string, delta: string): void {
		const prev = this.planBuffer;
		this.planBuffer = { runId: prev?.runId ?? runId, text: (prev?.text ?? "") + delta };
		if (!this.planTimer) {
			this.planTimer = setTimeout(() => this.flushPlanDelta(), this.deltaIntervalMs);
			// Never keep the process alive just for a coalescing flush.
			(this.planTimer as { unref?: () => void }).unref?.();
		}
	}

	private flushPlanDelta(): void {
		if (this.planTimer) {
			clearTimeout(this.planTimer);
			this.planTimer = null;
		}
		const buffer = this.planBuffer;
		if (!buffer) return;
		this.planBuffer = null;
		this.publish({ type: "plan_delta", runId: buffer.runId, delta: buffer.text });
	}

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

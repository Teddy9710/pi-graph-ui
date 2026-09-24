/**
 * RunManager - owns the (single) active orchestration run.
 *
 * Two entry paths share one run lifecycle:
 *  - start(graph): the editor's hand-composed graph runs directly;
 *  - startPlanned(goal): a planner instance first decomposes the goal into a
 *    graph (plan_* events, same runId), then the engine takes over seamlessly.
 *
 * Two RECOVERY paths reuse a finished run's outputs in a fresh run:
 *  - rerunFailed(fromRunId): ok nodes are seeded as precompleted (node_reused,
 *    never re-executed); error/skipped nodes re-run;
 *  - startRepair(fromRunId, nodeId): the planner rewrites a FAILED node's task
 *    with the error + upstream outputs as context (repair_* events, same
 *    mirror as plan_*), then the engine takes over with the other seeds.
 *
 * Bridges events out to WebSocket subscribers and the RunStore archive.
 * node_delta and plan_delta events are coalesced on a 150ms window — buffers
 * CONCATENATE (never latest-wins) so client previews stay faithful tails.
 * Structure events flush their pending buffer first, preserving
 * delta-before-completion ordering.
 *
 * Retention: events of the last run stay in memory until the next run starts,
 * so a browser refresh reconnects and replays them from hello. This is also
 * why recovery collects ALL its source materials BEFORE minting a new runId —
 * nextRunId() clears retention.
 */

import {
	validateGraph,
	zeroNodeUsage,
	type GraphDef,
	type GraphValidationIssue,
	type OrchResultNode,
	type RunEvent,
} from "@pi-graph/shared";
import { setTimeoutUnref, type UnrefableTimeout } from "./infra/timer-unref.ts";
import { OrchestratorEngine, type Executor } from "./orchestrator.ts";
import { MAX_GOAL_CHARS, type PlanOutcome, type RepairOutcome, type RepairRequest } from "./planner.ts";
import { RunStore } from "./run-store.ts";

export type StartResult = { ok: true; runId: string } | { ok: false; error: string; issues?: GraphValidationIssue[] };

/**
 * Gate decision notes ride the WS trust boundary and become the node's OUTPUT
 * (injected into downstream prompts) — bounded here like every other
 * client-supplied string. shared's fold trims it for display.
 */
export const MAX_GATE_NOTE_CHARS = 2000;

/** A gate note becomes the node's output, so downstream prompts inject it as
 *  section CONTENT — a newline or control char could forge another `### from
 *  …` header, the same header-forgery rule shared applies to node/edge labels.
 *  The web input is single-line; this guards the raw WS boundary.
 */
const GATE_NOTE_UNSAFE_RE = /[\u0000-\u001f\u007f]/;

/** Full gate-note validity: a string, single line, trimmed ≤ MAX_GATE_NOTE_CHARS. */
export function isValidGateNote(note: unknown): note is string {
	return (
		typeof note === "string" && !GATE_NOTE_UNSAFE_RE.test(note) && note.trim().length <= MAX_GATE_NOTE_CHARS
	);
}

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
	/** AI-repair seam — optional so existing fakes / old planners still satisfy the interface. */
	rewriteTask?(req: RepairRequest, ctx: { onDelta: (delta: string) => void; signal: AbortSignal }): Promise<RepairOutcome>;
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
	/**
	 * Engine-level auto-retry budget forwarded to every engine (a node's own
	 * maxRetries still overrides). Deliberately NO code default — the product
	 * default (ORCH_NODE_MAX_RETRIES) is applied by main.ts; undefined = 0
	 * retries, keeping bare-manager callers (tests) at the pre-retry behavior.
	 */
	maxRetries?: number;
	/** Delay between engine retry attempts (ms), forwarded like maxRetries. */
	retryDelayMs?: number;
}

export class RunManager {
	private readonly executor: Executor;
	private readonly planner: Planner | null;
	private readonly maxParallel: number | undefined;
	private readonly store: RunStore | null;
	private readonly deltaIntervalMs: number;
	private readonly now: () => number;
	private readonly onChatRunComplete: ((result: ChatRunResult) => void) | undefined;
	private readonly maxRetries: number | undefined;
	private readonly retryDelayMs: number | undefined;

	private engine: OrchestratorEngine | null = null;
	private planning = false;
	private plannerAbort: AbortController | null = null;
	private currentRunId: string | null = null;
	private retained: RunEvent[] = [];
	private readonly listeners = new Set<(event: RunEvent) => void>();
	/** nodeId → buffered delta text, WITH the runId it arrived under (a
	 *  post-settle tail must never be re-stamped with the next run's id). */
	private readonly deltaBuffers = new Map<string, { runId: string; text: string }>();
	private readonly deltaTimers = new Map<string, UnrefableTimeout>();
	private planBuffer: { runId: string; text: string; kind: "plan_delta" | "repair_delta" } | null = null;
	private planTimer: UnrefableTimeout | null = null;
	private runSeq = 0;

	constructor(options: RunManagerOptions) {
		this.executor = options.executor;
		this.planner = options.planner ?? null;
		this.maxParallel = options.maxParallel;
		this.store = options.store ?? null;
		this.deltaIntervalMs = options.deltaIntervalMs ?? 150;
		this.now = options.now ?? Date.now;
		this.onChatRunComplete = options.onChatRunComplete;
		this.maxRetries = options.maxRetries;
		this.retryDelayMs = options.retryDelayMs;
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
				onDelta: (delta) => this.retainPlanDelta(runId, delta, "plan_delta"),
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
					this.launchEngine(outcome.graph, runId, opts?.chat ? { chat: { goal: trimmed } } : undefined); // run_started continues the same run
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

	/**
	 * Human decision on an awaiting gate node. Guards: an ACTIVE engine under
	 * the matching runId and a single-line note within MAX_GATE_NOTE_CHARS
	 * (isValidGateNote — the note becomes prompt material downstream). The
	 * decision itself (and its node_decided broadcast) flows through the
	 * engine's existing event path — no separate channel.
	 */
	decideNode(runId: string, nodeId: string, approved: boolean, note: string): boolean {
		if (this.engine === null || runId !== this.currentRunId) return false;
		if (!isValidGateNote(note)) return false;
		return this.engine.decideNode(nodeId, approved, note);
	}

	/**
	 * 一键重跑失败部分: rerun a TERMINAL run's error/skipped nodes in a fresh
	 * run, seeding every ok node's output as precompleted (node_reused — the
	 * executor never sees them). Source materials come from retention (the
	 * last run) or the RunStore archive (older runs / after a restart).
	 */
	async rerunFailed(fromRunId: string): Promise<StartResult> {
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };
		const sourced = await this.sourceEvents(fromRunId);
		if (!sourced) return { ok: false, error: `找不到运行 ${fromRunId} 的记录` };
		const { events } = sourced;
		const runStarted = this.findRunStarted(events, fromRunId);
		if (!runStarted) return { ok: false, error: "该运行没有图记录，无法重跑" };
		if (!events.some((e) => e.type === "run_finished" && e.runId === fromRunId)) {
			return { ok: false, error: "该运行尚未结束，不能重跑" };
		}
		// Deep-copy: the archived graph must never be mutated (retention replays
		// it to refreshers; the archive file keeps the original).
		const graph = structuredClone(runStarted.graph);
		const seeds = this.collectSeeds(fromRunId, events, graph);
		const issues = validateGraph(graph);
		if (issues.length > 0) return { ok: false, error: "图校验未通过", issues };
		// The disk read awaited above is a gap — re-check before committing.
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };
		const runId = this.nextRunId();
		this.launchEngine(graph, runId, { precompleted: seeds });
		return { ok: true, runId };
	}

	/**
	 * AI 修复失败节点: the planner rewrites the FAILED node's task (error +
	 * upstream outputs as context), then the engine re-runs it under the SAME
	 * runId with every other ok node seeded — repair_started → repair_delta* →
	 * repair_completed → run_started, mirroring startPlanned. ALL source
	 * materials are collected BEFORE nextRunId() (which clears retention).
	 */
	async startRepair(fromRunId: string, nodeId: string): Promise<StartResult> {
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };
		const rewrite = this.planner?.rewriteTask?.bind(this.planner);
		if (!rewrite) return { ok: false, error: "服务器未配置修复器" };
		// --- collect everything the repair needs from the SOURCE run ---
		const sourced = await this.sourceEvents(fromRunId);
		if (!sourced) return { ok: false, error: `找不到运行 ${fromRunId} 的记录` };
		const { events } = sourced;
		const runStarted = this.findRunStarted(events, fromRunId);
		if (!runStarted) return { ok: false, error: "该运行没有图记录，无法修复" };
		const target = runStarted.graph.nodes.find((n) => n.id === nodeId);
		if (!target) return { ok: false, error: `节点 ${nodeId} 不在该运行中` };
		// A gate node's output is a HUMAN decision — no rewrite may stand in
		// for one; the gate is re-decided by rerunFailed instead.
		if (target.gate === true) return { ok: false, error: "门控节点不支持 AI 修复（人工决策不可改写）" };
		const failedEv = events.find(
			(e): e is Extract<RunEvent, { type: "node_failed" }> => e.type === "node_failed" && e.runId === fromRunId && e.nodeId === nodeId,
		);
		if (!failedEv) return { ok: false, error: `节点 ${nodeId} 在该运行中没有失败记录` };
		const graph = structuredClone(runStarted.graph);
		// Upstream material in graph edge order (same order assemblePrompt
		// injects on re-execution).
		const outputs = this.outputById(fromRunId, events);
		const upstream = graph.edges
			.filter((e) => e.target === nodeId)
			.map((e) => ({ nodeId: e.source, text: outputs.get(e.source) ?? "" }));
		const req: RepairRequest = {
			nodeId,
			task: target.task,
			error: failedEv.error,
			upstream,
			...(target.model !== undefined ? { model: target.model } : {}),
			...(target.tools !== undefined ? { tools: target.tools } : {}),
		};
		// Seeds exclude the target itself (E7: its old output is invalidated by
		// the rewrite) — collected now, before retention is cleared.
		const seeds = this.collectSeeds(fromRunId, events, graph, new Set([nodeId]));
		if (this.active) return { ok: false, error: "已有一次运行正在进行，请先中止" };

		// --- materials secured; mint the run id and drive the rewriter ---
		const runId = this.nextRunId();
		this.planning = true;
		const abort = new AbortController();
		this.plannerAbort = abort;
		this.publish({ type: "repair_started", runId, fromRunId, nodeId, startedAt: this.now() });

		let rewritten: Promise<RepairOutcome>;
		try {
			rewritten = rewrite(req, {
				onDelta: (delta) => this.retainPlanDelta(runId, delta, "repair_delta"),
				signal: abort.signal,
			});
		} catch (err) {
			// rewriteTask runs synchronously up to its first await; a seam that
			// throws synchronously must not wedge planning=true.
			console.error("[run-manager] rewriter threw synchronously:", err);
			this.finishRepair(runId, `修复器异常: ${(err as Error).message}`);
			return { ok: true, runId };
		}
		rewritten
			.then((outcome) => {
				// Aborted (or superseded): the terminal event already told the
				// story; late rewriter output must not touch the next run.
				if (!this.planning) return;
				this.flushPlanDelta();
				if (!outcome.ok) {
					this.finishRepair(runId, outcome.error);
					return;
				}
				// Apply the override: task ALWAYS replaced; model/tools replaced
				// when proposed, DELETED when omitted (the rewrite is
				// authoritative for this node — carrying the old config into a
				// fixed task re-introduces what was being repaired).
				const t = graph.nodes.find((n) => n.id === nodeId)!;
				t.task = outcome.task;
				if (outcome.model !== undefined) t.model = outcome.model;
				else delete t.model;
				if (outcome.tools !== undefined) t.tools = [...outcome.tools];
				else delete t.tools;
				const issues = validateGraph(graph);
				if (issues.length > 0) {
					this.finishRepair(runId, `修复后的图未通过校验：${issues[0]!.message}`);
					return;
				}
				this.publish({
					type: "repair_completed",
					runId,
					task: outcome.task,
					...(outcome.model !== undefined ? { model: outcome.model } : {}),
					...(outcome.tools !== undefined ? { tools: [...outcome.tools] } : {}),
				});
				this.clearPlanning();
				this.launchEngine(graph, runId, { precompleted: seeds }); // run_started continues the same run
			})
			.catch((err: Error) => {
				console.error("[run-manager] rewriter crashed:", err);
				if (this.planning) this.finishRepair(runId, `修复器异常: ${err.message}`);
			});
		return { ok: true, runId };
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

	/** Build + run the engine for a validated graph (shared by all paths).
	 *  `chat` requests the chat-complete hook for planned chat-first runs;
	 *  `precompleted` seeds ok-node outputs from a previous run. */
	private launchEngine(
		graph: GraphDef,
		runId: string,
		opts?: { chat?: { goal: string }; precompleted?: ReadonlyMap<string, { text: string; fromRunId: string }> },
	): void {
		const engine = new OrchestratorEngine(graph, this.executor, {
			runId,
			maxParallel: this.maxParallel,
			now: this.now,
			onEvent: (event) => this.retain(event),
			defaultMaxRetries: this.maxRetries,
			retryDelayMs: this.retryDelayMs,
			precompleted: opts?.precompleted,
		});
		this.engine = engine;
		void engine
			.run()
			.then((summary) => {
				// Timing guarantees: run_finished was published synchronously
				// INSIDE run() (clients flip the card to 完成 before injection
				// begins), and .finally below runs AFTER this .then — engine
				// bookkeeping is still set, so the runId can never be stale.
				if (opts?.chat && summary.status === "completed") this.fireChatComplete(runId, opts.chat.goal);
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
		const capById = new Map<string, number>();
		if (runStarted) {
			for (const node of runStarted.graph.nodes) {
				if (node.label) labelById.set(node.id, node.label);
				if (node.outputCapBytes !== undefined) capById.set(node.id, node.outputCapBytes);
			}
		}
		const nodes: OrchResultNode[] = [];
		for (const e of this.retained) {
			if (e.type === "node_completed" && e.runId === runId) {
				nodes.push({
					nodeId: e.nodeId,
					label: labelById.get(e.nodeId),
					text: e.output.text,
					...(capById.has(e.nodeId) ? { capBytes: capById.get(e.nodeId) } : {}),
				});
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

	/** repair_failed + a terminal run_finished (the repair counts as a run). */
	private finishRepair(runId: string, error: string): void {
		this.flushPlanDelta();
		this.publish({ type: "repair_failed", runId, error });
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

	/**
	 * A finished run's events: retention first (the last run, in memory), the
	 * RunStore archive second (older runs / after a restart). Null when the id
	 * is unknown to both.
	 */
	private async sourceEvents(fromRunId: string): Promise<{ events: RunEvent[] } | null> {
		if (this.retained.some((e) => e.runId === fromRunId)) return { events: [...this.retained] };
		if (!this.store) return null;
		const archived = await this.store.read(fromRunId);
		return archived.length > 0 ? { events: archived } : null;
	}

	private findRunStarted(events: readonly RunEvent[], runId: string): Extract<RunEvent, { type: "run_started" }> | null {
		return (
			events.find((e): e is Extract<RunEvent, { type: "run_started" }> => e.type === "run_started" && e.runId === runId) ??
			null
		);
	}

	/** Final output per node id for one run: completions, approved gate notes, reused seeds (in event order — later wins). */
	private outputById(runId: string, events: readonly RunEvent[]): Map<string, string> {
		const outputs = new Map<string, string>();
		for (const e of events) {
			if (e.runId !== runId) continue;
			if (e.type === "node_completed") outputs.set(e.nodeId, e.output.text);
			else if (e.type === "node_decided" && e.approved) outputs.set(e.nodeId, e.note.trim() || "（已批准）");
			else if (e.type === "node_reused") outputs.set(e.nodeId, e.output.text);
		}
		return outputs;
	}

	/**
	 * Seeds for a resume: every ok node's final output, keyed by node id.
	 * Ids absent from THIS graph are ignored (the archive may disagree with
	 * memory); nodes hit by `overrides` NEVER seed — their old output may be
	 * invalidated by what is about to change (E7).
	 */
	private collectSeeds(
		fromRunId: string,
		events: readonly RunEvent[],
		graph: GraphDef,
		overrides?: ReadonlySet<string>,
	): Map<string, { text: string; fromRunId: string }> {
		const outputs = this.outputById(fromRunId, events);
		const known = new Set(graph.nodes.map((n) => n.id));
		const seeds = new Map<string, { text: string; fromRunId: string }>();
		// node_reused seeds keep their ORIGINAL origin run (复用自 … stays
		// truthful across reruns of reruns).
		const originById = new Map<string, string>();
		for (const e of events) {
			if (e.type === "node_reused" && e.runId === fromRunId) originById.set(e.nodeId, e.fromRunId);
		}
		for (const [id, text] of outputs) {
			if (!known.has(id) || overrides?.has(id)) continue;
			seeds.set(id, { text, fromRunId: originById.get(id) ?? fromRunId });
		}
		return seeds;
	}

	private retainPlanDelta(runId: string, delta: string, kind: "plan_delta" | "repair_delta"): void {
		const prev = this.planBuffer;
		// The buffer keeps its ORIGINAL runId + kind (a post-settle tail must
		// never be re-stamped with the next run's identity or wrong channel).
		this.planBuffer = { runId: prev?.runId ?? runId, kind: prev?.kind ?? kind, text: (prev?.text ?? "") + delta };
		if (!this.planTimer) {
			this.planTimer = setTimeoutUnref(() => this.flushPlanDelta(), this.deltaIntervalMs);
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
		// plan_delta (planner drafting a graph) and repair_delta (planner
		// rewriting a failed node's task) share one coalescing buffer; the
		// kind decides which channel the flush emits on.
		if (buffer.kind === "plan_delta") this.publish({ type: "plan_delta", runId: buffer.runId, delta: buffer.text });
		else this.publish({ type: "repair_delta", runId: buffer.runId, delta: buffer.text });
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
				const timer = setTimeoutUnref(() => this.flushNode(event.nodeId), this.deltaIntervalMs);
				this.deltaTimers.set(event.nodeId, timer);
			}
			return;
		}
		// Structure events flush pending deltas first so clients observe
		// deltas strictly before the node's terminal event. node_retry joins
		// the list: attempt-1's buffered tail must land before the retry notice.
		if (
			event.type === "node_completed" ||
			event.type === "node_failed" ||
			event.type === "node_skipped" ||
			event.type === "node_retry"
		) {
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

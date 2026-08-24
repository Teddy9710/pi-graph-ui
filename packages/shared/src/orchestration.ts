/**
 * Graph orchestration model: the editable graph definition, the run event
 * stream the server emits while executing it, and the pure functions both
 * sides build on (validation, prompt assembly, output extraction, run-state
 * folding).
 *
 * Execution semantics: a node runs when ALL its upstreams completed ok
 * (AND-join); upstream outputs are appended to its task prompt; an upstream
 * failure skips the whole downstream closure transitively.
 */

import type { SessionState } from "./fold.ts";

// ============================================================================
// Graph definition (what the editor produces, the server executes)
// ============================================================================

/** Node ids are bare names — also used in edge ids and prompt headers. */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Model ids travel as a process ARGUMENT through a cmd.exe shim on Windows;
 * the shell joins args verbatim, so anything outside this safe set would be
 * interpreted as a cmd metacharacter (& | ^ < > % " etc.). Same reasoning
 * keeps agent names bare (they build a filesystem path under the agents dir).
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/+-]{0,127}$/;
export const AGENT_RE = NODE_ID_RE;

/** Per-upstream-output injection cap (mirrors pi's subagent extension). */
export const MAX_INJECTED_OUTPUT_BYTES = 50 * 1024;
/** Client/server streamed preview accumulation cap per node (chars). */
export const PREVIEW_CAP = 8 * 1024;
/**
 * Typed-edge vocabulary (graph engineering: an untyped edge carries 1 bit;
 * a typed edge makes the link reason-able). The id is the wire value
 * (EdgeDef.type, planner JSON); the label is the Chinese badge shown on the
 * canvas and injected into prompt headers. Fixed, closed set.
 */
export const EDGE_TYPES = ["input", "context", "review", "revise", "aggregate", "decide"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
	input: "输入",
	context: "参考",
	review: "审校",
	revise: "修订",
	aggregate: "汇总",
	decide: "决策",
};
const EDGE_TYPE_SET = new Set<string>(EDGE_TYPES);
/**
 * Optional edge NOTE (rides in the legacy `label` field). Short by design:
 * the TYPE carries the semantics; the note only disambiguates when two edges
 * of the same type differ (e.g. two 输入 edges with different materials).
 */
export const MAX_EDGE_NOTE_CHARS = 20;
/**
 * Notes ride INSIDE prompt section headers (`### from n1 —— 输入（备注）`);
 * a newline would let a label forge another `### from …` header that neither
 * the edge input nor the canvas label can visually audit. Single line only.
 */
const EDGE_NOTE_UNSAFE_RE = /[\u0000-\u001f\u007f]/;

export interface NodeDef {
	id: string;
	/** Display label; defaults to id. */
	label?: string;
	/** Task prompt. Upstream outputs are appended automatically at run time. */
	task: string;
	/** "provider/model"; falls back to the server default model. */
	model?: string;
	/** Persona name → ~/.pi/agent/agents/<name>.md (body via --append-system-prompt). */
	agent?: string;
	/** Editor-only canvas position; the server ignores it. */
	position?: { x: number; y: number };
}

export interface EdgeDef {
	/** Convention: `${source}->${target}` (see edgeId). */
	id: string;
	source: string;
	target: string;
	/** Typed relation from EDGE_TYPES; absent = "input" (every reader treats
	 *  a bare edge as a plain data dependency). */
	type?: EdgeType;
	/** Optional short NOTE (≤ MAX_EDGE_NOTE_CHARS) for when the type alone
	 *  can't tell the two same-typed edges apart. Field name kept from the
	 *  pre-typing era so persisted graphs / archived runs need no migration. */
	label?: string;
}

export interface GraphDef {
	name?: string;
	nodes: NodeDef[];
	edges: EdgeDef[];
}

export function edgeId(source: string, target: string): string {
	return `${source}->${target}`;
}

/**
 * Node ids that collide with Object.prototype members when a folded node map
 * is keyed by id. Assigning `map["__proto__"] = x` on a plain object invokes
 * the prototype SETTER instead of creating a key, and reading
 * `map["constructor"]` yields an inherited truthy function — validation
 * rejects them outright, and folding additionally uses null-prototype maps
 * (emptyNodeMap) as a backstop for adversarial input.
 */
const RESERVED_NODE_IDS = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);

// ============================================================================
// Validation
// ============================================================================

export interface GraphValidationIssue {
	/** Node id or edge id the issue is about, when attributable. */
	nodeOrEdge?: string;
	message: string;
}

/** Pure structural validation: ids, tasks, edges, self-loops, cycles.
 *  Total on malformed input (returns issues, never throws) — it sits on the
 *  WS trust boundary where `graph` arrives as arbitrary JSON. */
export function validateGraph(def: GraphDef): GraphValidationIssue[] {
	const issues: GraphValidationIssue[] = [];
	// Structural floor: anything that isn't a GraphDef-shaped object reports
	// as an issue instead of throwing on property access.
	if (typeof def !== "object" || def === null || !Array.isArray(def.nodes) || !Array.isArray(def.edges)) {
		return [{ message: "图结构无效（缺少 nodes/edges 数组）" }];
	}
	if (def.nodes.length === 0) {
		issues.push({ message: "图中没有节点" });
		return issues;
	}
	const seen = new Set<string>();
	for (const n of def.nodes) {
		if (typeof n !== "object" || n === null || typeof n.id !== "string" || typeof n.task !== "string") {
			issues.push({ message: "存在畸形节点（缺少字符串 id/task）" });
			continue;
		}
		if (!NODE_ID_RE.test(n.id)) issues.push({ nodeOrEdge: n.id, message: `节点 id 非法（仅限字母/数字/_/-，1-64 字符）` });
		// A planner-steerable id must never reach a keyed node map (see
		// RESERVED_NODE_IDS): "__proto__" would poison the prototype chain.
		if (RESERVED_NODE_IDS.has(n.id)) {
			issues.push({ nodeOrEdge: n.id, message: "节点 id 不能使用 JS 保留名（__proto__/constructor 等）" });
		}
		if (seen.has(n.id)) issues.push({ nodeOrEdge: n.id, message: "节点 id 重复" });
		seen.add(n.id);
		if (!n.task.trim()) issues.push({ nodeOrEdge: n.id, message: "任务 prompt 为空" });
		if (n.model !== undefined && (typeof n.model !== "string" || !MODEL_RE.test(n.model))) {
			issues.push({ nodeOrEdge: n.id, message: "model 含非法字符（仅限字母/数字/./_/+/-//，且不以 / 开头）" });
		}
		if (n.agent !== undefined && (typeof n.agent !== "string" || !AGENT_RE.test(n.agent))) {
			issues.push({ nodeOrEdge: n.id, message: "agent 名非法（仅限字母/数字/_/-，1-64 字符）" });
		}
	}
	const edgeSeen = new Set<string>();
	const pairSeen = new Set<string>();
	for (const e of def.edges) {
		if (typeof e !== "object" || e === null || typeof e.source !== "string" || typeof e.target !== "string") {
			issues.push({ message: "存在畸形边（缺少字符串 source/target）" });
			continue;
		}
		if (!seen.has(e.source) || !seen.has(e.target)) {
			issues.push({ nodeOrEdge: typeof e.id === "string" ? e.id : "?", message: "边引用了不存在的节点" });
			continue;
		}
		if (e.source === e.target) issues.push({ nodeOrEdge: e.id, message: "不允许自环" });
		// Typed edge: absent type is LENIENT (every reader defaults it to
		// "input"), a present-but-unknown one is a hard error — the planner
		// feedback and the editor issue list both need the valid ids spelled
		// out, so the message lists ids, not badges.
		if (e.type !== undefined && (typeof e.type !== "string" || !EDGE_TYPE_SET.has(e.type))) {
			issues.push({ nodeOrEdge: e.id, message: `边 type 非法（必须是 ${EDGE_TYPES.join("/")} 之一）` });
		}
		if (e.label !== undefined && (typeof e.label !== "string" || e.label.length > MAX_EDGE_NOTE_CHARS)) {
			issues.push({ nodeOrEdge: e.id, message: `边 label 非法（字符串，≤${MAX_EDGE_NOTE_CHARS} 字符）` });
		}
		// A note with newlines could forge another "### from n3" section header
		// inside the assembled prompt — unauditable from the single-line UI.
		if (typeof e.label === "string" && EDGE_NOTE_UNSAFE_RE.test(e.label)) {
			issues.push({ nodeOrEdge: e.id, message: "边 label 不能包含换行或控制字符" });
		}
		if (edgeSeen.has(e.id)) issues.push({ nodeOrEdge: e.id, message: "边重复" });
		edgeSeen.add(e.id);
		// One edge per direction: duplicates would double-inject the upstream
		// output and smear one edge's relation label onto its sibling.
		const pair = `${e.source}->${e.target}`;
		if (pairSeen.has(pair)) {
			issues.push({ nodeOrEdge: e.id, message: `节点 ${e.source}→${e.target} 之间已有一条边，不允许重复连线` });
		}
		pairSeen.add(pair);
	}
	// Kahn's algorithm: nodes whose indegree never reaches 0 are on/behind a cycle.
	const indegree = new Map<string, number>();
	const downstream = new Map<string, string[]>();
	for (const n of def.nodes) {
		indegree.set(n.id, 0);
		downstream.set(n.id, []);
	}
	for (const e of def.edges) {
		if (!indegree.has(e.source) || !indegree.has(e.target) || e.source === e.target) continue;
		indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
		downstream.get(e.source)!.push(e.target);
	}
	const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
	const peeled = new Set<string>();
	while (queue.length > 0) {
		const id = queue.shift()!;
		peeled.add(id);
		for (const next of downstream.get(id) ?? []) {
			const d = (indegree.get(next) ?? 1) - 1;
			indegree.set(next, d);
			if (d === 0) queue.push(next);
		}
	}
	if (peeled.size < def.nodes.length) {
		const cyclic = def.nodes.filter((n) => !peeled.has(n.id)).map((n) => n.id);
		issues.push({ nodeOrEdge: cyclic.join(", "), message: "图中存在环（DAG 不允许）" });
	}
	return issues;
}

// ============================================================================
// Prompt assembly + output extraction
// ============================================================================

/** Head-preserving byte-cap truncation that works on both sides of the wire. */
export function truncateBytes(text: string, maxBytes: number): { text: string; capped: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= maxBytes) return { text, capped: false };
	// Cut on the byte budget; TextDecoder replaces any split code point.
	const cut = new TextDecoder().decode(bytes.slice(0, maxBytes));
	return { text: cut, capped: true };
}

/** One upstream contribution to a node's assembled prompt. */
export interface UpstreamInput {
	nodeId: string;
	text: string;
	/** The edge's typed relation; absent = "input". */
	type?: EdgeType;
	/** The edge's optional short note. */
	label?: string;
}

/**
 * Assemble a node's full prompt: its task, then every upstream output under a
 * deterministic header (graph node order), each capped at
 * MAX_INJECTED_OUTPUT_BYTES. The section header carries the edge's TYPE badge
 * (with the optional note in full-width parens) so the executor knows HOW the
 * input is meant to be used, not just from whom it arrives:
 * `### from n1 —— 输入` / `### from n1 —— 汇总（提供调研数据）`.
 */
export function assemblePrompt(node: NodeDef, upstream: UpstreamInput[]): string {
	if (upstream.length === 0) return node.task;
	const sections = upstream.map(({ nodeId, text, type, label }) => {
		const { text: capped, capped: wasCapped } = truncateBytes(text, MAX_INJECTED_OUTPUT_BYTES);
		const badge = EDGE_TYPE_LABELS[type ?? "input"];
		const note = label ? `（${label}）` : "";
		return `### from ${nodeId} —— ${badge}${note}\n${capped}${wasCapped ? "\n\n（输出过长，已截断）" : ""}`;
	});
	return `${node.task}\n\n---\n## 上游输入\n\n${sections.join("\n\n")}`;
}

/**
 * Last assistant text of a folded session (mirrors pi's subagent
 * getFinalOutput): skips thinking and toolCall blocks.
 */
export function finalOutput(state: SessionState): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m?.role !== "assistant") continue;
		return m.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
	}
	return "";
}

// ============================================================================
// Run events (server → client)
// ============================================================================

export type RunStatus = "running" | "completed" | "failed" | "aborted";
export type NodeRunStatus = "pending" | "running" | "ok" | "error" | "skipped";

/** Usage summary per node / per run (flattened from fold.ts Usage). */
export interface NodeUsage {
	input: number;
	output: number;
	totalTokens: number;
	/** Total cost in dollars. */
	cost: number;
}

export function zeroNodeUsage(): NodeUsage {
	return { input: 0, output: 0, totalTokens: 0, cost: 0 };
}

export function addNodeUsage(total: NodeUsage, delta: NodeUsage): NodeUsage {
	total.input += delta.input || 0;
	total.output += delta.output || 0;
	total.totalTokens += delta.totalTokens || 0;
	total.cost += delta.cost || 0;
	return total;
}

/**
 * Planning phase (auto-orchestration): plan_started → plan_delta* →
 * plan_completed → run_started (same runId; the engine takes over) — or
 * plan_failed. The planner decomposes a free-text goal into the GraphDef
 * that run_started then executes.
 */
export type RunEvent =
	| { type: "run_started"; runId: string; startedAt: number; graph: GraphDef }
	| { type: "plan_started"; runId: string; goal: string; startedAt: number }
	| { type: "plan_delta"; runId: string; delta: string }
	| { type: "plan_completed"; runId: string; graph: GraphDef }
	| { type: "plan_failed"; runId: string; error: string }
	| { type: "node_started"; runId: string; nodeId: string; startedAt: number; assembledPrompt: string }
	| { type: "node_delta"; runId: string; nodeId: string; kind: "text" | "tool"; delta: string }
	| {
			type: "node_completed";
			runId: string;
			nodeId: string;
			endedAt: number;
			durationMs: number;
			output: { text: string; stopReason: string; model?: string; usage: NodeUsage };
	  }
	| { type: "node_failed"; runId: string; nodeId: string; endedAt: number; durationMs: number; error: string }
	| { type: "node_skipped"; runId: string; nodeId: string; reason: string }
	| {
			type: "run_finished";
			runId: string;
			finishedAt: number;
			status: RunStatus;
			ok: number;
			failed: number;
			skipped: number;
			usage: NodeUsage;
	  };

// ============================================================================
// Client-side run state folding (same pattern as foldEvent)
// ============================================================================

export interface RunNodeState {
	id: string;
	status: NodeRunStatus;
	startedAt: number | null;
	endedAt: number | null;
	assembledPrompt: string | null;
	output: string | null;
	stopReason: string | null;
	model: string | null;
	usage: NodeUsage | null;
	error: string | null;
	skipReason: string | null;
	/** Capped streamed preview (tail-preserving, PREVIEW_CAP). */
	preview: string;
}

export interface RunState {
	runId: string | null;
	/** "planning" = the planner phase of an auto-orchestrated run. */
	status: "idle" | "planning" | RunStatus;
	/** The goal an auto run was planned from (null for manual editor runs). */
	goal: string | null;
	/** Tail-capped planner output stream (the plan JSON being drafted). */
	planText: string;
	planError: string | null;
	/** The graph that was executed (captured at run_started — not the live editor graph). */
	graph: GraphDef | null;
	nodes: Record<string, RunNodeState>;
	startedAt: number | null;
	finishedAt: number | null;
	ok: number;
	failed: number;
	skipped: number;
	usage: NodeUsage;
}

export function initRunState(): RunState {
	return {
		runId: null,
		status: "idle",
		goal: null,
		planText: "",
		planError: null,
		graph: null,
		nodes: emptyNodeMap(),
		startedAt: null,
		finishedAt: null,
		ok: 0,
		failed: 0,
		skipped: 0,
		usage: zeroNodeUsage(),
	};
}

/**
 * Node maps key by id with NO prototype — `map["__proto__"] = x` creates a
 * plain own key instead of firing the Object.prototype setter, and inherited
 * lookups (`map["constructor"]`) yield undefined instead of truthy members.
 * Validation rejects reserved ids; this keeps folding total regardless.
 */
export function emptyNodeMap(): Record<string, RunNodeState> {
	return Object.create(null);
}

function initNode(id: string): RunNodeState {
	return {
		id,
		status: "pending",
		startedAt: null,
		endedAt: null,
		assembledPrompt: null,
		output: null,
		stopReason: null,
		model: null,
		usage: null,
		error: null,
		skipReason: null,
		preview: "",
	};
}

/**
 * Fold one run event into the run state (mutating it). Stale-runId and
 * unknown-nodeId events are ignored, so replay + live share one path.
 */
export function foldRunEvent(state: RunState, event: RunEvent): RunState {
	// Stale-runId guard — EXCEPT the two reset points (run_started /
	// plan_started): a new run starting on a live connection must RESET the
	// state, not be ignored as stale (otherwise a browser that stays connected
	// across two runs shows the first run forever).
	if (event.type !== "run_started" && event.type !== "plan_started" && state.runId !== null && event.runId !== state.runId) {
		return state;
	}
	switch (event.type) {
		case "plan_started": {
			state.runId = event.runId;
			state.status = "planning";
			state.goal = event.goal;
			state.planText = "";
			state.planError = null;
			state.graph = null;
			state.nodes = emptyNodeMap();
			state.startedAt = event.startedAt;
			state.finishedAt = null;
			state.ok = 0;
			state.failed = 0;
			state.skipped = 0;
			state.usage = zeroNodeUsage();
			return state;
		}
		case "plan_delta": {
			state.planText = (state.planText + event.delta).slice(-PREVIEW_CAP);
			return state;
		}
		case "plan_completed": {
			state.graph = event.graph; // nodes materialize on run_started
			return state;
		}
		case "plan_failed": {
			state.planError = event.error;
			state.status = "failed";
			return state;
		}
		case "run_started": {
			// Same runId = continuation of the plan phase (keep goal/planText);
			// different runId = fresh manual run (clear the previous goal).
			if (state.runId !== event.runId) state.goal = null;
			state.runId = event.runId;
			state.status = "running";
			state.graph = event.graph;
			state.startedAt = event.startedAt;
			state.finishedAt = null;
			state.ok = 0;
			state.failed = 0;
			state.skipped = 0;
			state.usage = zeroNodeUsage();
			state.nodes = emptyNodeMap();
			for (const n of event.graph.nodes) {
				// Total on adversarial graphs: a reserved id that slipped past
				// validation becomes a plain own key on the null-prototype map.
				state.nodes[n.id] = initNode(n.id);
			}
			return state;
		}
		case "node_started": {
			const node = state.nodes[event.nodeId];
			if (!node) return state;
			node.status = "running";
			node.startedAt = event.startedAt;
			node.assembledPrompt = event.assembledPrompt;
			return state;
		}
		case "node_delta": {
			const node = state.nodes[event.nodeId];
			if (!node) return state;
			node.preview = (node.preview + event.delta).slice(-PREVIEW_CAP);
			return state;
		}
		case "node_completed": {
			const node = state.nodes[event.nodeId];
			if (!node) return state;
			node.status = "ok";
			node.endedAt = event.endedAt;
			node.output = event.output.text;
			node.stopReason = event.output.stopReason;
			node.model = event.output.model ?? null;
			node.usage = event.output.usage;
			return state;
		}
		case "node_failed": {
			const node = state.nodes[event.nodeId];
			if (!node) return state;
			node.status = "error";
			node.endedAt = event.endedAt;
			node.error = event.error;
			return state;
		}
		case "node_skipped": {
			const node = state.nodes[event.nodeId];
			if (!node) return state;
			node.status = "skipped";
			node.skipReason = event.reason;
			return state;
		}
		case "run_finished": {
			state.status = event.status;
			state.finishedAt = event.finishedAt;
			state.ok = event.ok;
			state.failed = event.failed;
			state.skipped = event.skipped;
			state.usage = event.usage;
			return state;
		}
	}
}

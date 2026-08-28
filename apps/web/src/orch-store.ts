/**
 * Orchestration editor store: the editable GraphDef is the single source of
 * truth (canvas positions included), selection, validation issues recomputed
 * on every mutation, and the folded run state fed by run events routed here
 * from the shared WebSocket (store.ts). The graph persists to localStorage
 * (debounced 300ms); corrupted data falls back to the blank template.
 */

import { create } from "zustand";
import {
	EDGE_TYPES,
	TEMPLATES,
	edgeId,
	emptyNodeMap,
	foldRunEvent,
	initRunState,
	validateGraph,
	type EdgeType,
	type GraphDef,
	type GraphValidationIssue,
	type NodeDef,
	type RunEvent,
	type RunState,
} from "@pi-graph/shared";
import { autoLayoutGraphDef } from "./orch-layout.ts";
// Circular import with store.ts is INTENTIONAL and safe: both sides only hold
// function references that are called at runtime (never during module
// evaluation), and function declarations are hoisted before any import runs.
import { sendWs } from "./store.ts";

const STORAGE_KEY = "pi-graph.orch.graph.v1";
const PERSIST_DELAY_MS = 300;
/** planRun's guard is echo-based — run.status only flips when plan_started
 *  comes back. A second send inside that round-trip would just earn a spurious
 *  busy run_error (double-click / Enter+click); absorb it locally. */
const PLAN_SEND_GUARD_MS = 1000;
let lastPlanSentAt = 0;

interface OrchState {
	graphDef: GraphDef;
	selectedNodeId: string | null;
	/** The selected edge (type/note editing); mutually exclusive with
	 *  selectedNodeId — one panel, one subject. */
	selectedEdgeId: string | null;
	/** validateGraph(graphDef) — recomputed on every mutation. */
	issues: GraphValidationIssue[];
	/** Folded run state (idle until the first run event arrives). */
	run: RunState;
	/** "editor" = hand-edit graphDef; "run" = read-only view of run.graph
	 *  (auto-switched when a planned run starts streaming). */
	view: "editor" | "run";
	/** Why the last connection attempt was rejected (cycle/duplicate/self-loop). */
	connectIssue: string | null;
	/** Server-side run rejection (run_error envelope); cleared on next run start. */
	orchError: { message: string; issues: GraphValidationIssue[] } | null;
	addNode: () => void;
	/** Patch a node's editable fields. The id is the node's identity — never editable. */
	updateNode: (id: string, patch: Partial<NodeDef>) => void;
	updateNodePosition: (id: string, position: { x: number; y: number }) => void;
	/** Remove a node and prune every edge that touched it. */
	deleteNode: (id: string) => void;
	/** Add source->target after validating the CANDIDATE graph; a rejected edge
	 *  surfaces an issue instead of mutating. */
	connectEdge: (source: string, target: string) => void;
	deleteEdge: (id: string) => void;
	/** Clone a template (position-free) and assign positions via auto-layout. */
	applyTemplate: (key: string) => void;
	clearCanvas: () => void;
	/** Recompute positions for ALL nodes via dagre. */
	autoArrange: () => void;
	select: (id: string | null) => void;
	/** Select an edge (null clears). Clears the node selection. */
	selectEdge: (id: string | null) => void;
	/** Set an edge's TYPE from the fixed vocabulary. */
	updateEdgeType: (id: string, type: EdgeType) => void;
	/** Set/clear an edge's optional note (empty input clears it). */
	updateEdgeLabel: (id: string, label: string) => void;
	/** Client-side validateGraph gate: issues → never sent. */
	runGraph: () => void;
	abortRun: () => void;
	/** Auto-orchestrate: send the goal, the server plans then runs (plan_run).
	 *  opts.chat = on completion the server injects the compiled node outputs
	 *  into the main session agent (chat-first orchestration). */
	planRun: (goal: string, opts?: { chat?: boolean }) => void;
	setView: (view: "editor" | "run") => void;
	/** Copy the generated/executed run graph into the editor for hand-tuning. */
	importGraphFromRun: () => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Latest graph awaiting persistence (also the beforeunload flush source). */
let pendingGraph: GraphDef | null = null;

function persistNow(): void {
	persistTimer = null;
	const def = pendingGraph;
	if (!def) return;
	pendingGraph = null;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, graph: def }));
	} catch {
		// Storage unavailable/full — keep editing in memory.
	}
}

function schedulePersist(def: GraphDef): void {
	pendingGraph = def;
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

// Close/refresh mid-debounce would silently revert the last ≤300ms of edits.
if (typeof window !== "undefined") {
	window.addEventListener("pagehide", persistNow);
	window.addEventListener("beforeunload", persistNow);
}

/** Structural sanity for localStorage payloads; anything else falls back. */
function isGraphLike(value: unknown): value is GraphDef {
	if (typeof value !== "object" || value === null) return false;
	const def = value as { nodes?: unknown; edges?: unknown };
	if (!Array.isArray(def.nodes) || !Array.isArray(def.edges)) return false;
	return def.nodes.every(
		(n) =>
			typeof n === "object" &&
			n !== null &&
			typeof (n as { id?: unknown }).id === "string" &&
			typeof (n as { task?: unknown }).task === "string",
	);
}

function cloneGraph(def: GraphDef): GraphDef {
	return JSON.parse(JSON.stringify(def)) as GraphDef;
}

function loadGraph(): GraphDef {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as { version?: number; graph?: unknown };
			// An in-progress graph may legitimately have validation issues
			// (empty task etc.) — only structurally corrupt data falls back.
			if (parsed?.version === 1 && isGraphLike(parsed.graph)) return parsed.graph;
		}
	} catch {
		// Corrupted JSON — fall through to the blank template.
	}
	return cloneGraph(TEMPLATES.find((t) => t.key === "blank")!.graph);
}

/** State patch for a committed graph mutation: new def, fresh issues,
 *  cleared connection notice, and a debounced persist. */
function graphState(def: GraphDef): Pick<OrchState, "graphDef" | "issues" | "connectIssue"> {
	schedulePersist(def);
	return { graphDef: def, issues: validateGraph(def), connectIssue: null };
}

const initialGraph = loadGraph();

export const useOrchStore = create<OrchState>((set, get) => ({
	graphDef: initialGraph,
	selectedNodeId: null,
	selectedEdgeId: null,
	issues: validateGraph(initialGraph),
	run: initRunState(),
	view: "editor",
	connectIssue: null,
	orchError: null,

	addNode: () =>
		set((s) => {
			const ids = new Set(s.graphDef.nodes.map((n) => n.id));
			let i = s.graphDef.nodes.length + 1;
			while (ids.has(`node-${i}`)) i++;
			const n = s.graphDef.nodes.length; // stagger spawn positions on a grid
			const node: NodeDef = {
				id: `node-${i}`,
				label: `节点 ${i}`,
				task: "",
				position: { x: 60 + (n % 5) * 260, y: 60 + Math.floor(n / 5) * 140 },
			};
			return { ...graphState({ ...s.graphDef, nodes: [...s.graphDef.nodes, node] }), selectedNodeId: node.id, selectedEdgeId: null };
		}),

	updateNode: (id, patch) =>
		set((s) => {
			if (!s.graphDef.nodes.some((n) => n.id === id)) return {};
			// id is the node's identity — never editable through a patch.
			const { id: _ignored, ...rest } = patch;
			const clean: Partial<NodeDef> = {};
			// Empty optional strings clear the field (undefined → dropped from JSON).
			if ("label" in rest) clean.label = rest.label?.trim() ? rest.label : undefined;
			if ("task" in rest) clean.task = rest.task ?? "";
			if ("model" in rest) clean.model = rest.model?.trim() || undefined;
			if ("agent" in rest) clean.agent = rest.agent?.trim() || undefined;
			if ("position" in rest && rest.position) clean.position = rest.position;
			const nodes = s.graphDef.nodes.map((n) => (n.id === id ? { ...n, ...clean } : n));
			return graphState({ ...s.graphDef, nodes });
		}),

	updateNodePosition: (id, position) =>
		set((s) => {
			if (!s.graphDef.nodes.some((n) => n.id === id)) return {};
			const nodes = s.graphDef.nodes.map((n) => (n.id === id ? { ...n, position } : n));
			return graphState({ ...s.graphDef, nodes });
		}),

	deleteNode: (id) =>
		set((s) => {
			// Prune every edge that touched the node.
			const edges = s.graphDef.edges.filter((e) => e.source !== id && e.target !== id);
			return {
				...graphState({ ...s.graphDef, nodes: s.graphDef.nodes.filter((n) => n.id !== id), edges }),
				selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
				// A pruned edge must not stay selected.
				selectedEdgeId: edges.some((e) => e.id === s.selectedEdgeId) ? s.selectedEdgeId : null,
			};
		}),

	connectEdge: (source, target) =>
		set((s) => {
			if (source === target) return { connectIssue: "不允许自环" };
			const id = edgeId(source, target);
			if (s.graphDef.edges.some((e) => e.id === id)) return { connectIssue: `边 ${id} 已存在` };
			// Validate the CANDIDATE graph, but only reject for issues this edge
			// INTRODUCES (cycle/duplicate/self-loop) — pre-existing issues
			// elsewhere (e.g. an empty task) must not block connecting.
			// New edges start as the default type "input"; the panel can refine.
			const candidate: GraphDef = {
				...s.graphDef,
				edges: [...s.graphDef.edges, { id, source, target, type: "input" }],
			};
			const before = new Set(validateGraph(s.graphDef).map((i) => `${i.nodeOrEdge ?? ""}|${i.message}`));
			const fresh = validateGraph(candidate).filter((i) => !before.has(`${i.nodeOrEdge ?? ""}|${i.message}`));
			if (fresh.length > 0) {
				return {
					connectIssue: `连线被拒绝：${fresh.map((i) => (i.nodeOrEdge ? `${i.nodeOrEdge}：` : "") + i.message).join("；")}`,
				};
			}
			return graphState(candidate);
		}),

	deleteEdge: (id) =>
		set((s) => ({
			...graphState({ ...s.graphDef, edges: s.graphDef.edges.filter((e) => e.id !== id) }),
			selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
		})),

	applyTemplate: (key) =>
		set((s) => {
			const tpl = TEMPLATES.find((t) => t.key === key);
			if (!tpl) return {};
			// Templates are module constants — clone, then assign positions.
			return {
				...graphState(autoLayoutGraphDef(cloneGraph(tpl.graph))),
				selectedNodeId: null,
				selectedEdgeId: null,
			};
		}),

	clearCanvas: () =>
		set((s) => ({ ...graphState({ nodes: [], edges: [] }), selectedNodeId: null, selectedEdgeId: null })),

	autoArrange: () => set((s) => graphState(autoLayoutGraphDef(s.graphDef))),

	select: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),

	selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),

	updateEdgeType: (id, type) =>
		set((s) => {
			// The select only offers EDGE_TYPES; this guard is just defense.
			if (!EDGE_TYPES.includes(type)) return {};
			if (!s.graphDef.edges.some((e) => e.id === id)) return {};
			// "input" is written EXPLICITLY too — the chosen type must survive
			// persistence rather than rely on ?? "input" at every read site.
			const edges = s.graphDef.edges.map((e) => (e.id === id ? { ...e, type } : e));
			return graphState({ ...s.graphDef, edges });
		}),

	updateEdgeLabel: (id, label) =>
		set((s) => {
			if (!s.graphDef.edges.some((e) => e.id === id)) return {};
			// Trimmed-empty clears the note (undefined → dropped from JSON);
			// the input's maxLength enforces MAX_EDGE_NOTE_CHARS.
			const clean = label.trim() ? label : undefined;
			const edges = s.graphDef.edges.map((e) => {
				if (e.id !== id) return e;
				const { label: _old, ...rest } = e;
				return clean ? { ...rest, label: clean } : rest;
			});
			return graphState({ ...s.graphDef, edges });
		}),

	runGraph: () => {
		const s = get();
		if (s.run.status === "running" || s.run.status === "planning") return;
		// Client-side gate: never send a graph that doesn't validate.
		if (s.issues.length > 0) return;
		set({ orchError: null });
		sendWs({ type: "run_graph", graph: s.graphDef });
	},

	abortRun: () => sendWs({ type: "abort_run" }),

	planRun: (goal, opts) => {
		const s = get();
		if (s.run.status === "running" || s.run.status === "planning") return;
		const trimmed = goal.trim();
		if (!trimmed) return;
		if (Date.now() - lastPlanSentAt < PLAN_SEND_GUARD_MS) return;
		lastPlanSentAt = Date.now();
		set({ orchError: null });
		// plan_started echoes back and flips the view to "run".
		sendWs({ type: "plan_run", goal: trimmed, chat: opts?.chat === true });
	},

	setView: (view) => set({ view }),

	importGraphFromRun: () =>
		set((s) => {
			if (!s.run.graph || s.run.status === "running" || s.run.status === "planning") return {};
			// Fresh positions via auto-layout — generated nodes carry none.
			return {
				...graphState(autoLayoutGraphDef(cloneGraph(s.run.graph))),
				selectedNodeId: null,
				selectedEdgeId: null,
				view: "editor",
			};
		}),
}));

// ============================================================================
// Hooks for the store.ts WS router (hello replay / live events / run errors).
// The store.ts ↔ orch-store.ts import cycle is intentional — see top of file.
// ============================================================================;

/** Replace the run state with a fresh fold of the given events (hello replay). */
export function setRunSnapshot(events: RunEvent[] | undefined): void {
	const fresh = initRunState();
	if (events) for (const event of events) foldRunEvent(fresh, event);
	useOrchStore.setState((s) => ({
		run: fresh,
		// Only a COLD session (previous status idle — page load/refresh) is
		// steered back onto the run view of an in-flight auto run. hello also
		// fires on every automatic reconnect, and there it must respect an
		// explicit 返回编辑器 the user clicked mid-run.
		view:
			s.run.status === "idle" &&
			(fresh.status === "planning" || (fresh.status === "running" && fresh.goal !== null))
				? "run"
				: s.view,
	}));
}

/** Fold one live run event into the run state. foldRunEvent mutates in place,
 *  so clone for zustand reference selectors — but only what the event can
 *  touch: node_* events mutate exactly ONE record (foldRunEvent never crosses
 *  nodes otherwise; plan_/run_ events replace the whole map or top-level
 *  fields). Cloning every record on every node_delta meant a full re-render
 *  of all run subscribers per streamed token; this way unchanged node
 *  records keep their references. The map clone stays null-prototype
 *  (emptyNodeMap) like every other node map — a spread would reopen the
 *  __proto__ injection surface emptyNodeMap exists to close. */
export function applyRunEvent(event: RunEvent): void {
	useOrchStore.setState((s) => {
		const next: RunState = { ...s.run, nodes: Object.assign(emptyNodeMap(), s.run.nodes) };
		if ("nodeId" in event) {
			const record = next.nodes[event.nodeId];
			if (record) next.nodes[event.nodeId] = { ...record };
		}
		foldRunEvent(next, event);
		// An auto-orchestrated run takes over the canvas: the generated graph
		// only exists in the run state, not in the editor — and the editor's
		// selections reference that graph, so they must not leak into the run
		// view's panel (ids can coincide).
		if (event.type === "plan_started") {
			return { run: next, view: "run" as const, selectedNodeId: null, selectedEdgeId: null };
		}
		return { run: next, view: s.view };
	});
}

/** Surface a server-side run rejection (run_error envelope). */
export function setOrchError(err: { message?: string; issues?: unknown }): void {
	const issues = Array.isArray(err.issues) ? (err.issues as GraphValidationIssue[]) : [];
	useOrchStore.setState({ orchError: { message: err.message ?? "run failed", issues } });
}

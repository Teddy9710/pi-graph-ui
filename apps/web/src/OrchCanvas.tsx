/**
 * The two orchestration canvases behind one component:
 *  - editor view: a controlled React Flow editor — nodes/edges derive from the
 *    orch store's graphDef and every interaction (drag-end, delete, connect)
 *    writes back into it;
 *  - run view: a READ-ONLY projection of run.graph (the generated graph an
 *    auto-orchestrated run is executing), laid out once per graph identity so
 *    streaming events never reflow positions.
 * Both lock interaction while a run executes. Unlike GraphCanvas (a derived
 * read-only projection of the LIVE session), these own orchestration state.
 *
 * Node selection is driven by RF's `select` changes (onNodesChange) — click
 * AND keyboard Enter/Escape both arrive there, and handleNodeClick runs
 * before any onNodeClick prop, so a toggle in both would cancel itself out.
 * Edge selection keeps its click-toggle: edges opt out of RF selection
 * (selectable: false) to keep our typed-edge colors.
 */

import { useMemo, useRef, useState } from "react";
import {
	Background,
	Controls,
	MarkerType,
	MiniMap,
	ReactFlow,
	type Connection,
	type Edge,
	type EdgeChange,
	type EdgeMouseHandler,
	type Node,
	type NodeChange,
	type OnEdgesChange,
	type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { orchNodeTypes, type OrchNodeData } from "./orch-nodes.tsx";
import { autoLayoutGraphDef } from "./orch-layout.ts";
import { useOrchStore } from "./orch-store.ts";
import { EDGE_TYPE_LABELS, type EdgeDef, type GraphDef, type RunNodeState } from "@pi-graph/shared";

/** RF renders a string label as ONE unwrapped SVG <text> line — long text
 *  draws an unwrapped band across the endpoint nodes. The badge (2 chars)
 *  plus separator plus note (≤20) can reach 23; the COMBINED string is
 *  capped here, the full pair lives in the edge panel. */
const EDGE_LABEL_DISPLAY_CHARS = 20;

function edgeStyle(e: EdgeDef, opts: { selected?: boolean } = {}): Edge {
	const selected = opts.selected === true;
	// Every edge shows at least its TYPE badge — the graph reads as typed
	// transitions (输入/参考/审校/…), with the optional note appended. Old
	// graphs without a type default to 输入.
	const text = e.label ? `${EDGE_TYPE_LABELS[e.type ?? "input"]}·${e.label}` : EDGE_TYPE_LABELS[e.type ?? "input"];
	return {
		id: e.id,
		source: e.source,
		target: e.target,
		label: text.length > EDGE_LABEL_DISPLAY_CHARS
			? `${text.slice(0, EDGE_LABEL_DISPLAY_CHARS)}…`
			: text,
		labelStyle: { fill: "#8b93a5", fontSize: 11 },
		labelBgStyle: { fill: "#0e1014" },
		labelBgPadding: [6, 3] as [number, number],
		labelBgBorderRadius: 4,
		// No RF edge-selection (its default gray selected stroke fights our
		// colors — same reasoning as GraphCanvas); click handlers + our own
		// selected stroke drive the editor's edge selection instead.
		selectable: false,
		style: selected ? { stroke: "#5b9bf8", strokeWidth: 2 } : undefined,
		markerEnd: {
			type: MarkerType.ArrowClosed,
			width: 16,
			height: 16,
			color: selected ? "#5b9bf8" : "#8b93a5",
		},
	};
}

/**
 * Per-id data-object cache: node components only re-render when their node
 * def or run record actually changed. applyRunEvent clones just the touched
 * record, so untouched runNode refs stay equal — without this cache every
 * streamed token would hand every node a fresh data object.
 */
function useNodeDataCache(): Map<string, OrchNodeData> {
	const ref = useRef<Map<string, OrchNodeData> | null>(null);
	if (ref.current === null) ref.current = new Map();
	return ref.current;
}

function cachedData(
	cache: Map<string, OrchNodeData>,
	id: string,
	label: string,
	node: GraphDef["nodes"][number],
	runNode: RunNodeState | null,
): OrchNodeData {
	const cached = cache.get(id);
	if (cached && cached.node === node && cached.runNode === runNode) return cached;
	const data: OrchNodeData = { label, node, runNode };
	cache.set(id, data);
	return data;
}

function Canvas() {
	const graphDef = useOrchStore((s) => s.graphDef);
	const run = useOrchStore((s) => s.run);
	const selectedNodeId = useOrchStore((s) => s.selectedNodeId);
	const selectedEdgeId = useOrchStore((s) => s.selectedEdgeId);
	const updateNodePosition = useOrchStore((s) => s.updateNodePosition);
	const deleteNode = useOrchStore((s) => s.deleteNode);
	const deleteEdge = useOrchStore((s) => s.deleteEdge);
	const connectEdge = useOrchStore((s) => s.connectEdge);
	const select = useOrchStore((s) => s.select);
	const selectEdge = useOrchStore((s) => s.selectEdge);
	const running = run.status === "running";
	const dataCache = useNodeDataCache();

	// Ephemeral positions while a drag is in flight. In a controlled flow,
	// unapplied position changes would snap the node back mid-drag; the store
	// is only written when the drag ends (change.dragging === false).
	const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});

	const nodes = useMemo<Node[]>(
		() =>
			graphDef.nodes.map((n) => ({
				id: n.id,
				type: "orch",
				position: dragPositions[n.id] ?? n.position ?? { x: 0, y: 0 },
				data: cachedData(dataCache, n.id, n.label || n.id, n, run.nodes[n.id] ?? null),
				selected: n.id === selectedNodeId,
			})),
		[graphDef, run, selectedNodeId, dragPositions, dataCache],
	);

	const edges = useMemo<Edge[]>(
		() => graphDef.edges.map((e) => edgeStyle(e, { selected: e.id === selectedEdgeId })),
		[graphDef, selectedEdgeId],
	);

	const onNodesChange: OnNodesChange = (changes: NodeChange[]) => {
		// Selection derives from the whole batch: one click can carry
		// [new→true, old→false] in any order (RF iterates its lookup map) —
		// any true wins, all-false clears. store select() also clears the
		// edge selection (one subject per panel).
		let selectionTouched = false;
		let selectedId: string | null = null;
		for (const change of changes) {
			if (change.type === "position" && change.position) {
				const pos = change.position;
				if (change.dragging) {
					setDragPositions((prev) => ({ ...prev, [change.id]: pos }));
				} else {
					// Drag ended — persist the final position to the graph.
					updateNodePosition(change.id, pos);
					setDragPositions((prev) => {
						if (!(change.id in prev)) return prev;
						const next = { ...prev };
						delete next[change.id];
						return next;
					});
				}
			} else if (change.type === "remove") {
				deleteNode(change.id);
			} else if (change.type === "select") {
				selectionTouched = true;
				if (change.selected) selectedId = change.id;
			}
		}
		if (selectionTouched) select(selectedId);
	};

	const onEdgesChange: OnEdgesChange = (changes: EdgeChange[]) => {
		for (const change of changes) if (change.type === "remove") deleteEdge(change.id);
	};

	const onConnect = (connection: Connection) => {
		const { source, target } = connection;
		if (!source || !target || source === target) return;
		connectEdge(source, target);
	};

	// Clicking an edge selects it for label editing (node selection clears).
	const onEdgeClick: EdgeMouseHandler = (_, edge) => {
		selectEdge(edge.id === selectedEdgeId ? null : edge.id);
	};

	return (
		<>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={orchNodeTypes}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				onEdgeClick={onEdgeClick}
				onPaneClick={() => select(null)}
				deleteKeyCode={["Backspace", "Delete"]}
				nodesDraggable={!running}
				nodesConnectable={!running}
				colorMode="dark"
				// fitView only fires on init — no refitting while the user edits.
				fitView
				minZoom={0.15}
				maxZoom={2}
			>
				<Background gap={22} color="rgba(255 255 255 / 0.07)" />
				<Controls showInteractive={false} />
				<MiniMap pannable zoomable nodeStrokeWidth={2} />
			</ReactFlow>
			{nodes.length === 0 && (
				<div className="pg-orch-empty">画布是空的——从上方选一个模板，或点「＋节点」开始</div>
			)}
		</>
	);
}

/** Read-only canvas for run.graph (auto-orchestrated runs). */
function RunCanvas() {
	const run = useOrchStore((s) => s.run);
	const selectedNodeId = useOrchStore((s) => s.selectedNodeId);
	const select = useOrchStore((s) => s.select);
	const dataCache = useNodeDataCache();

	const graph = run.graph;
	// Layout keyed by CONTENT signature, not object identity: plan_completed
	// and run_started each deliver their own copy of the same graph (re-running
	// dagre on the twin would rebuild identical positions), while run/status
	// updates must never reflow. Ids ALONE are not enough — after 转入编辑器 a
	// manual rerun can swap in an EDITED graph with the same ids (tasks OR edge
	// types/notes), and the memo would keep rendering the stale bodies.
	const signature = graph
		? `${graph.nodes.map((n) => `${n.id}${n.label ?? ""}${n.task}${n.model ?? ""}${n.agent ?? ""}`).join(",")}|${graph.edges.map((e) => `${e.id}${e.type ?? ""}${e.label ?? ""}`).join(",")}`
		: "";
	const laid = useMemo(
		() => (graph && signature ? autoLayoutGraphDef(graph) : null),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- signature IS the dependency
		[signature],
	);

	const nodes = useMemo<Node[]>(
		() =>
			laid
				? laid.nodes.map((n) => ({
						id: n.id,
						type: "orch",
						position: n.position ?? { x: 0, y: 0 },
						data: cachedData(dataCache, n.id, n.label || n.id, n, run.nodes[n.id] ?? null),
						selected: n.id === selectedNodeId,
					}))
				: [],
		[laid, run, selectedNodeId, dataCache],
	);
	const edges = useMemo<Edge[]>(() => (laid ? laid.edges.map((e) => edgeStyle(e)) : []), [laid]);

	// Keyboard parity with the editor canvas (mouse clicks share this path).
	// Batch-derived like the editor's handler — see the comment there.
	const onNodesChange = (changes: NodeChange[]) => {
		let touched = false;
		let selectedId: string | null = null;
		for (const change of changes) {
			if (change.type === "select") {
				touched = true;
				if (change.selected) selectedId = change.id;
			}
		}
		if (touched) select(selectedId);
	};

	if (!laid) {
		return (
			<div className="pg-orch-empty">
				{run.status === "planning" ? "规划中——任务图生成后会在这里展开…" : "尚无可展示的运行图"}
			</div>
		);
	}

	return (
		<ReactFlow
			nodes={nodes}
			edges={edges}
			nodeTypes={orchNodeTypes}
			onNodesChange={onNodesChange}
			onPaneClick={() => select(null)}
			// Strictly read-only: the generated graph is inspected, never edited.
			nodesDraggable={false}
			nodesConnectable={false}
			deleteKeyCode={null}
			colorMode="dark"
			fitView
			minZoom={0.15}
			maxZoom={2}
		>
			<Background gap={22} color="rgba(255 255 255 / 0.07)" />
			<Controls showInteractive={false} />
			<MiniMap pannable zoomable nodeStrokeWidth={2} />
		</ReactFlow>
	);
}

export function OrchCanvas() {
	const view = useOrchStore((s) => s.view);
	const runStatus = useOrchStore((s) => s.run.status);
	return (
		<div className="pg-orch-canvas-wrap">
			{view === "run" ? <RunCanvas /> : <Canvas />}
			{runStatus === "running" && view === "editor" && <div className="pg-orch-lock">运行中，画布锁定</div>}
		</div>
	);
}

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
 */

import { useMemo, useState } from "react";
import {
	Background,
	Controls,
	MarkerType,
	MiniMap,
	ReactFlow,
	type Connection,
	type Edge,
	type EdgeChange,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type OnEdgesChange,
	type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { orchNodeTypes } from "./orch-nodes.tsx";
import { autoLayoutGraphDef } from "./orch-layout.ts";
import { useOrchStore } from "./orch-store.ts";

function edgeStyle(e: { id: string; source: string; target: string }): Edge {
	return {
		id: e.id,
		source: e.source,
		target: e.target,
		// No edge-selection UI; opting out also avoids RF's default gray
		// selected stroke overriding our colors (same reasoning as GraphCanvas).
		selectable: false,
		markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#9aa3b5" },
	};
}

function Canvas() {
	const graphDef = useOrchStore((s) => s.graphDef);
	const run = useOrchStore((s) => s.run);
	const selectedNodeId = useOrchStore((s) => s.selectedNodeId);
	const updateNodePosition = useOrchStore((s) => s.updateNodePosition);
	const deleteNode = useOrchStore((s) => s.deleteNode);
	const deleteEdge = useOrchStore((s) => s.deleteEdge);
	const connectEdge = useOrchStore((s) => s.connectEdge);
	const select = useOrchStore((s) => s.select);
	const running = run.status === "running";

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
				data: { label: n.label || n.id, node: n, runNode: run.nodes[n.id] ?? null },
				selected: n.id === selectedNodeId,
			})),
		[graphDef, run, selectedNodeId, dragPositions],
	);

	const edges = useMemo<Edge[]>(() => graphDef.edges.map(edgeStyle), [graphDef]);

	const onNodesChange: OnNodesChange = (changes: NodeChange[]) => {
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
			}
		}
	};

	const onEdgesChange: OnEdgesChange = (changes: EdgeChange[]) => {
		for (const change of changes) if (change.type === "remove") deleteEdge(change.id);
	};

	const onConnect = (connection: Connection) => {
		const { source, target } = connection;
		if (!source || !target || source === target) return;
		connectEdge(source, target);
	};

	const onNodeClick: NodeMouseHandler = (_, node) => {
		select(node.id === selectedNodeId ? null : node.id);
	};

	return (
		<ReactFlow
			nodes={nodes}
			edges={edges}
			nodeTypes={orchNodeTypes}
			onNodesChange={onNodesChange}
			onEdgesChange={onEdgesChange}
			onConnect={onConnect}
			onNodeClick={onNodeClick}
			onPaneClick={() => select(null)}
			deleteKeyCode={["Backspace", "Delete"]}
			nodesDraggable={!running}
			nodesConnectable={!running}
			// fitView only fires on init — no refitting while the user edits.
			fitView
			minZoom={0.15}
			maxZoom={2}
		>
			<Background gap={22} />
			<Controls showInteractive={false} />
			<MiniMap pannable zoomable nodeStrokeWidth={2} />
		</ReactFlow>
	);
}

/** Read-only canvas for run.graph (auto-orchestrated runs). */
function RunCanvas() {
	const run = useOrchStore((s) => s.run);
	const selectedNodeId = useOrchStore((s) => s.selectedNodeId);
	const select = useOrchStore((s) => s.select);

	const graph = run.graph;
	// Layout keyed by CONTENT signature, not object identity: plan_completed
	// and run_started each deliver their own copy of the same graph (re-running
	// dagre on the twin would rebuild identical positions), while run/status
	// updates must never reflow. Ids ALONE are not enough — after 转入编辑器 a
	// manual rerun can swap in an EDITED graph with the same ids, and the memo
	// would keep rendering the stale bodies.
	const signature = graph
		? `${graph.nodes.map((n) => `${n.id}${n.label ?? ""}${n.task}${n.model ?? ""}${n.agent ?? ""}`).join(",")}|${graph.edges.map((e) => e.id).join(",")}`
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
						data: { label: n.label || n.id, node: n, runNode: run.nodes[n.id] ?? null },
						selected: n.id === selectedNodeId,
					}))
				: [],
		[laid, run, selectedNodeId],
	);
	const edges = useMemo<Edge[]>(() => (laid ? laid.edges.map(edgeStyle) : []), [laid]);

	const onNodeClick: NodeMouseHandler = (_, node) => {
		select(node.id === selectedNodeId ? null : node.id);
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
			onNodeClick={onNodeClick}
			onPaneClick={() => select(null)}
			// Strictly read-only: the generated graph is inspected, never edited.
			nodesDraggable={false}
			nodesConnectable={false}
			deleteKeyCode={null}
			fitView
			minZoom={0.15}
			maxZoom={2}
		>
			<Background gap={22} />
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

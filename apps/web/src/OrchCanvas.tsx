/**
 * Controlled React Flow editor for the orchestration graph: nodes/edges are
 * derived from the orch store, and every interaction (drag-end, delete,
 * connect) is written back into it. The canvas locks (no drag/connect) while a
 * run is executing. Unlike GraphCanvas (a derived read-only projection), this
 * component owns editing — the two never share state.
 */

import { useMemo, useState } from "react";
import {
	Background,
	Controls,
	MarkerType,
	MiniMap,
	ReactFlow,
	ReactFlowProvider,
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
import { useOrchStore } from "./orch-store.ts";

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

	const edges = useMemo<Edge[]>(
		() =>
			graphDef.edges.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				// No edge-selection UI; opting out also avoids RF's default gray
				// selected stroke overriding our colors (same reasoning as GraphCanvas).
				selectable: false,
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#9aa3b5" },
			})),
		[graphDef],
	);

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

export function OrchCanvas() {
	const running = useOrchStore((s) => s.run.status === "running");
	return (
		<div className="pg-orch-canvas-wrap">
			<Canvas />
			{running && <div className="pg-orch-lock">运行中，画布锁定</div>}
		</div>
	);
}

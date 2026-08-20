/**
 * React Flow canvas: laid-out graph with kind-based edge styling.
 * spawn edges (agent fan-out) render dashed + animated while the target runs.
 * Refits the viewport whenever new nodes appear so streaming growth stays
 * visible.
 */

import { useEffect, useMemo, useRef } from "react";
import {
	Background,
	Controls,
	MiniMap,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type Edge,
	type Node,
	type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph } from "./layout.ts";
import { nodeTypes } from "./nodes.tsx";
import { useStore } from "./store.ts";

function Canvas() {
	const graph = useStore((s) => s.graph);
	const select = useStore((s) => s.select);
	const selectedNodeId = useStore((s) => s.selectedNodeId);
	const { fitView } = useReactFlow();
	const lastCount = useRef(-1);

	const nodes = useMemo<Node[]>(
		() =>
			layoutGraph(graph).map((n) => ({
				id: n.id,
				type: n.type,
				position: n.position,
				// React Flow requires Record<string, unknown> node data.
				data: n.data as unknown as Record<string, unknown>,
				selected: n.id === selectedNodeId,
			})),
		[graph, selectedNodeId],
	);

	const edges = useMemo<Edge[]>(
		() =>
			graph.edges.map((e) => {
				const target = graph.nodes.find((n) => n.id === e.target);
				const running = target?.data.status === "running";
				return {
					id: e.id,
					source: e.source,
					target: e.target,
					className: `pg-edge pg-edge-${e.kind}${running ? " pg-edge-live" : ""}`,
					animated: running,
					type: e.kind === "spawn" ? "smoothstep" : "default",
				};
			}),
		[graph],
	);

	// Refit when new nodes appear (fitView prop only fires on init).
	useEffect(() => {
		if (nodes.length !== lastCount.current) {
			lastCount.current = nodes.length;
			// Defer so React Flow registers the new nodes first.
			const t = setTimeout(() => void fitView({ duration: 300, padding: 0.15 }), 50);
			return () => clearTimeout(t);
		}
	}, [nodes.length, fitView]);

	const onNodeClick: NodeMouseHandler = (_, node) => {
		select(node.id === selectedNodeId ? null : node.id);
	};

	return (
		<ReactFlow
			nodes={nodes}
			edges={edges}
			nodeTypes={nodeTypes}
			onNodeClick={onNodeClick}
			onPaneClick={() => select(null)}
			nodesDraggable={false}
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

export function GraphCanvas() {
	return (
		<ReactFlowProvider>
			<Canvas />
		</ReactFlowProvider>
	);
}

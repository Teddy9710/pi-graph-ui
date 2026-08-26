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
	MarkerType,
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
import type { Graph } from "@pi-graph/shared";

/**
 * @param graphOverride render an archived graph instead of the live one
 * @param compact strip Controls + MiniMap (the 400px side-column 实时图 IS a
 *        minimap already — stacking RF chrome inside it just eats canvas)
 */
function Canvas({ graphOverride, compact = false }: { graphOverride?: Graph; compact?: boolean }) {
	const liveGraph = useStore((s) => s.graph);
	const graph = graphOverride ?? liveGraph;
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
				// Arrowheads bake their color into an inline style, so they
				// must be given the same per-kind color as the CSS stroke.
				const color = running ? "#5b9bf8" : e.kind === "spawn" ? "#7ba4e0" : "#8b93a5";
				return {
					id: e.id,
					source: e.source,
					target: e.target,
					className: `pg-edge pg-edge-${e.kind}${running ? " pg-edge-live" : ""}`,
					animated: running,
					type: e.kind === "spawn" ? "smoothstep" : "default",
					// No edge-selection UI; opting out also avoids RF's default
					// gray selected stroke overriding our colors.
					selectable: false,
					// Arrows make the parent->child direction explicit.
					markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
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
			colorMode="dark"
			fitView
			minZoom={0.15}
			maxZoom={2}
		>
			<Background gap={22} color="rgba(255 255 255 / 0.07)" />
			{!compact && <Controls showInteractive={false} />}
			{!compact && <MiniMap pannable zoomable nodeStrokeWidth={2} />}
		</ReactFlow>
	);
}

export function GraphCanvas({ graphOverride, compact }: { graphOverride?: Graph; compact?: boolean }) {
	return (
		<ReactFlowProvider>
			<Canvas graphOverride={graphOverride} compact={compact} />
		</ReactFlowProvider>
	);
}

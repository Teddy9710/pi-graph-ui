/**
 * dagre auto-layout for the derived graph. Deterministic: same graph shape
 * yields stable positions, so streaming updates don't jump nodes around.
 */

import dagre from "@dagrejs/dagre";
import type { Graph, GraphNode } from "@pi-graph/shared";

/** Approximate node sizes per kind (px). */
const SIZES: Record<GraphNode["data"]["kind"], { width: number; height: number }> = {
	session: { width: 150, height: 44 },
	user: { width: 230, height: 64 },
	assistant: { width: 230, height: 64 },
	tool: { width: 190, height: 42 },
	"subagent-call": { width: 210, height: 48 },
	agent: { width: 190, height: 56 },
	"agent-tool": { width: 180, height: 38 },
};

export function layoutGraph(graph: Graph): GraphNode[] {
	const g = new dagre.graphlib.Graph();
	g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 72, edgesep: 12, marginx: 40, marginy: 40 });
	// Required: without a default edge label, edge labels stay undefined and
	// dagre.layout crashes writing `edge.points`.
	g.setDefaultEdgeLabel(() => ({}));
	for (const node of graph.nodes) {
		const size = SIZES[node.data.kind] ?? { width: 180, height: 44 };
		g.setNode(node.id, { ...size });
	}
	for (const edge of graph.edges) {
		g.setEdge({ v: edge.source, w: edge.target });
	}
	dagre.layout(g);
	return graph.nodes.map((node) => {
		const pos = g.node(node.id);
		if (!pos) return node;
		// dagre yields node CENTERS; React Flow positions are top-left.
		return {
			...node,
			position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
		};
	});
}

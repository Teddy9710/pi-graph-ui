/**
 * dagre auto-layout for the orchestration editor graph (LR). Only used when
 * seeding a template and by the 自动整理 button — never during a run, canvas
 * positions belong to the user once they've touched the graph.
 *
 * Mirrors layout.ts (same rankdir/seps, same dagre crash-guard): dagre
 * positions are node CENTERS, React Flow wants top-left.
 */

import dagre from "@dagrejs/dagre";
import type { GraphDef } from "@pi-graph/shared";

/** OrchNode is ~220px wide; 64px approximates its collapsed height. */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;

/**
 * Return a full clone of the def with positions recomputed for ALL nodes
 * (isolated nodes included; edges keep their identity).
 */
export function autoLayoutGraphDef(def: GraphDef): GraphDef {
	const cloned: GraphDef = {
		name: def.name,
		nodes: def.nodes.map((n) => ({ ...n })),
		edges: def.edges.map((e) => ({ ...e })),
	};
	if (cloned.nodes.length === 0) return cloned;
	const g = new dagre.graphlib.Graph();
	g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 72, edgesep: 12, marginx: 40, marginy: 40 });
	// Required: without a default edge label, edge labels stay undefined and
	// dagre.layout crashes writing `edge.points`.
	g.setDefaultEdgeLabel(() => ({}));
	for (const n of cloned.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	for (const e of cloned.edges) g.setEdge({ v: e.source, w: e.target });
	dagre.layout(g);
	for (const n of cloned.nodes) {
		const pos = g.node(n.id);
		if (!pos) continue;
		// dagre yields node CENTERS; React Flow positions are top-left.
		n.position = { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 };
	}
	return cloned;
}

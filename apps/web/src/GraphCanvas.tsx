/**
 * React Flow canvas: laid-out graph with kind-based edge styling.
 * spawn edges (agent fan-out) render dashed + animated while the target runs.
 *
 * Layout: dagre runs ONCE per topology change, not per streamed event — token
 * deltas and status flips never move nodes (sizes depend only on ids/edges/
 * kind), so positions are memoized on a topology signature while node DATA
 * stays fresh per event.
 *
 * Viewport: refits when new nodes appear (fitView prop only fires on init),
 * but the user's manual pan/zoom wins — once they navigate, auto-fit stands
 * down until the graph empties (new session) re-arms it.
 *
 * Selection: RF's own click/keyboard machinery emits `select` changes through
 * onNodesChange (handleNodeClick runs BEFORE any onNodeClick prop, so a toggle
 * in both handlers would cancel itself out) — that change stream is the single
 * writer of our selection, which is what mounts the detail panel.
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
	type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph } from "./layout.ts";
import { nodeTypes } from "./nodes.tsx";
import { useStore } from "./store.ts";
import type { Graph } from "@pi-graph/shared";

/**
 * @param graphOverride render an archived graph instead of the live one
 * @param compact strip the MiniMap (the 400px side-column 实时图 IS a minimap
 *        already — stacking one inside it just eats canvas). Controls stay:
 *        once auto-fit respects user navigation, a shrunken viewport needs
 *        the fit-view button to find its way back.
 */
function Canvas({ graphOverride, compact = false }: { graphOverride?: Graph; compact?: boolean }) {
	const liveGraph = useStore((s) => s.graph);
	const graph = graphOverride ?? liveGraph;
	const select = useStore((s) => s.select);
	const selectedNodeId = useStore((s) => s.selectedNodeId);
	const { fitView } = useReactFlow();

	// Topology signature: positions depend only on ids + edges (+ per-kind
	// sizes). ingest() recreates the graph object on every event; keying the
	// dagre memo on this string keeps full relayouts off the per-token path.
	const topologyKey = useMemo(
		() => `${graph.nodes.map((n) => n.id).join(",")}|${graph.edges.map((e) => e.id).join(",")}`,
		[graph],
	);
	// eslint-disable-next-line react-hooks/exhaustive-deps -- topologyKey IS the dependency
	const positions = useMemo(() => {
		const map = new Map<string, { x: number; y: number }>();
		for (const n of layoutGraph(graph)) map.set(n.id, n.position);
		return map;
	}, [topologyKey]);

	const nodes = useMemo<Node[]>(
		() =>
			graph.nodes.map((n) => ({
				id: n.id,
				type: n.type,
				position: positions.get(n.id) ?? { x: 0, y: 0 },
				// React Flow requires Record<string, unknown> node data.
				data: n.data as unknown as Record<string, unknown>,
				selected: n.id === selectedNodeId,
			})),
		[graph, positions, selectedNodeId],
	);

	const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
	const edges = useMemo<Edge[]>(
		() =>
			graph.edges.map((e) => {
				const target = byId.get(e.target);
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
		[graph, byId],
	);

	// Refit on node-count growth; see the header comment. lastCount starts at
	// -1 so the first nodes of a session fit too.
	const lastCount = useRef(-1);
	const userNavigated = useRef(false);
	const programmaticMove = useRef(false);
	useEffect(() => {
		if (nodes.length === 0) {
			// Session reset / new task — the next graph starts from a clean slate.
			lastCount.current = 0;
			userNavigated.current = false;
			return;
		}
		if (nodes.length === lastCount.current || userNavigated.current) return;
		lastCount.current = nodes.length;
		// 400ms coalesces the node bursts a fan-out drops in quick succession.
		const t = setTimeout(() => {
			programmaticMove.current = true;
			// The reduced-motion media query can't reach d3-zoom — duration 0.
			const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300;
			void fitView({ duration, padding: 0.15 }).then(() => {
				programmaticMove.current = false;
			});
		}, 400);
		return () => clearTimeout(t);
	}, [nodes.length, fitView]);

	// Single selection writer: mouse clicks AND keyboard Enter/Escape both
	// arrive as select changes (mounts/clears the detail panel). One click can
	// carry [new→true, old→false] in ANY order (RF iterates its lookup map),
	// so derive from the whole batch: any true wins, all-false clears.
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

	return (
		<>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				onNodesChange={onNodesChange}
				onPaneClick={() => select(null)}
				onMoveStart={() => {
					// fitView's own animation must not read as the user navigating.
					if (!programmaticMove.current) userNavigated.current = true;
				}}
				nodesDraggable={false}
				colorMode="dark"
				fitView
				minZoom={0.15}
				maxZoom={2}
			>
				<Background gap={22} color="rgba(255 255 255 / 0.07)" />
				<Controls showInteractive={false} />
				{!compact && <MiniMap pannable zoomable nodeStrokeWidth={2} />}
			</ReactFlow>
			{nodes.length === 0 && (
				<div className="pg-orch-empty">
					{graphOverride ? "该会话没有可展示的事件" : "会话开始后，事件会实时画成节点图"}
				</div>
			)}
		</>
	);
}

export function GraphCanvas({ graphOverride, compact }: { graphOverride?: Graph; compact?: boolean }) {
	return (
		<ReactFlowProvider>
			<Canvas graphOverride={graphOverride} compact={compact} />
		</ReactFlowProvider>
	);
}

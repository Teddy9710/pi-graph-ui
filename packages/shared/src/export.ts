/**
 * Export / import helpers for orchestration graphs and runs.
 * These are pure and environment-agnostic — no DOM, no clipboard — so they
 * can be unit-tested and reused by both the web bundle and the server.
 */

import {
	validateGraph,
	type GraphDef,
	type GraphValidationIssue,
	type NodeUsage,
	type RunNodeState,
	type RunState,
} from "./orchestration.ts";

/** Serializable view of a finished run, suitable for copy/download/share. */
export interface RunExport {
	runId: string | null;
	status: RunState["status"];
	goal: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	graph: GraphDef | null;
	nodes: Array<{
		id: string;
		status: RunNodeState["status"];
		startedAt: number | null;
		endedAt: number | null;
		durationMs: number | null;
		output: string | null;
		error: string | null;
		skipReason: string | null;
		model: string | null;
		usage: NodeUsage | null;
		attempts: number | null;
		reusedFrom: string | null;
		artifactDir: string | null;
	}>;
	usage: NodeUsage;
}

/** Pretty-print a GraphDef as JSON. */
export function exportGraphToJson(graph: GraphDef): string {
	return JSON.stringify(graph, null, 2);
}

function nodeDurationMs(node: RunNodeState): number | null {
	if (node.startedAt != null && node.endedAt != null) {
		return Math.max(0, node.endedAt - node.startedAt);
	}
	return null;
}

/** Build a deterministic, shareable snapshot from a folded run state. */
export function buildRunExport(run: RunState): RunExport {
	const graph = run.graph;
	const nodeEntries = Object.values(run.nodes);
	const order = graph?.nodes.map((n) => n.id) ?? nodeEntries.map((n) => n.id);
	const nodeById = new Map(nodeEntries.map((n) => [n.id, n]));
	const nodes = order
		.map((id) => nodeById.get(id))
		.filter((n): n is RunNodeState => n != null)
		.map((n) => ({
			id: n.id,
			status: n.status,
			startedAt: n.startedAt,
			endedAt: n.endedAt,
			durationMs: nodeDurationMs(n),
			output: n.output,
			error: n.error,
			skipReason: n.skipReason,
			model: n.model,
			usage: n.usage,
			attempts: n.attempts,
			reusedFrom: n.reusedFrom,
			artifactDir: n.artifactDir ?? null,
		}));
	return {
		runId: run.runId,
		status: run.status,
		goal: run.goal,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		graph,
		nodes,
		usage: { ...run.usage },
	};
}

function isGraphLike(value: unknown): value is GraphDef {
	if (typeof value !== "object" || value === null) return false;
	const def = value as { nodes?: unknown; edges?: unknown; name?: unknown };
	if (!Array.isArray(def.nodes) || !Array.isArray(def.edges)) return false;
	if (def.name !== undefined && typeof def.name !== "string") return false;
	return true;
}

/** Parse clipboard/file text into a GraphDef, or return a user-facing error. */
export function parseGraphJson(text: string): { graph: GraphDef } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "内容不是合法 JSON" };
	}
	if (!isGraphLike(parsed)) {
		return { error: "不是有效的图结构（需要对象，含 nodes/edges 数组）" };
	}
	return { graph: parsed };
}

/** Join validation issues into a single Chinese sentence. */
export function formatImportIssues(issues: GraphValidationIssue[]): string {
	return issues.map((i) => (i.nodeOrEdge ? `${i.nodeOrEdge}：${i.message}` : i.message)).join("；");
}

const FILENAME_UNSAFE_RE = /[\\/\?%*:|"<>\n\r\t]+/g;

/** Sanitize a user-supplied string for use in a filename. */
export function sanitizeFilename(name: string): string {
	const cleaned = name.replace(FILENAME_UNSAFE_RE, " ").trim();
	return cleaned.length > 0 ? cleaned : "untitled";
}

export { validateGraph };
export type { GraphDef, GraphValidationIssue, NodeUsage };

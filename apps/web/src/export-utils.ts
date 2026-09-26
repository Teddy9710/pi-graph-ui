/**
 * Browser-side export / import utilities for the orchestration editor.
 */

import {
	exportGraphToJson,
	parseGraphJson,
	validateGraph,
	sanitizeFilename,
	type GraphDef,
	type GraphValidationIssue,
	type RunExport,
} from "@pi-graph/shared";

export async function copyText(text: string): Promise<void> {
	if (!navigator.clipboard) {
		throw new Error("当前环境不支持剪贴板");
	}
	await navigator.clipboard.writeText(text);
}

export function downloadJson(json: string, filename: string): void {
	const blob = new Blob([json], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function readTextFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () => reject(new Error("读取文件失败"));
		reader.readAsText(file);
	});
}

export type ImportGraphResult =
	| { graph: GraphDef; issues: GraphValidationIssue[] }
	| { error: string };

function isGraphObject(value: unknown): value is GraphDef {
	if (typeof value !== "object" || value === null) return false;
	const v = value as { nodes?: unknown; edges?: unknown; name?: unknown };
	return Array.isArray(v.nodes) && Array.isArray(v.edges) && (v.name === undefined || typeof v.name === "string");
}

export function importGraphDef(input: unknown): ImportGraphResult {
	let candidate: unknown;
	if (typeof input === "string") {
		const parsed = parseGraphJson(input);
		if ("error" in parsed) return parsed;
		candidate = parsed.graph;
	} else {
		candidate = input;
	}
	if (!isGraphObject(candidate)) {
		return { error: "不是有效的图结构（需要对象，含 nodes/edges 数组）" };
	}
	const graph = JSON.parse(JSON.stringify(candidate)) as GraphDef;
	return { graph, issues: validateGraph(graph) };
}

function timestampSuffix(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function graphExportFilename(graph: GraphDef): string {
	const base = sanitizeFilename(graph.name ?? "untitled");
	return `pigraph-${base}-${timestampSuffix()}.json`;
}

export function runExportFilename(run: RunExport): string {
	const base = sanitizeFilename(run.runId ?? "draft");
	return `pigraph-run-${base}-${timestampSuffix()}.json`;
}

export { exportGraphToJson };

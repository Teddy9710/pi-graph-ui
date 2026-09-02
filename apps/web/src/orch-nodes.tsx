/**
 * Orchestration editor node: left/right connection handles, a status dot
 * (pending/running/ok/error/skipped), bold label plus @agent/model chips, and
 * a compact run preview — stream tail while running, output tail / error
 * snippet / skip reason once the node settles. Gate nodes lead the head row
 * with a mono 「门」 mark and breathe amber while awaiting a human decision.
 * Stays ~220px wide to match the size dagre lays out with (orch-layout.ts).
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodeDef, RunNodeState } from "@pi-graph/shared";
import "./nodes.css";

/** React Flow v12 node data must be Record<string, unknown>. */
export interface OrchNodeData extends Record<string, unknown> {
	label: string;
	node: NodeDef;
	runNode: RunNodeState | null;
}

type OrchNodeProps = NodeProps & { data: OrchNodeData };

function lastLines(text: string, lines: number): string {
	const parts = text.replace(/\r/g, "").split("\n");
	return parts.slice(-lines).join("\n");
}

export function OrchNode({ data }: OrchNodeProps) {
	const { node, runNode } = data;
	const status = runNode?.status ?? "pending";
	const chips: string[] = [];
	if (node.agent) chips.push(`@${node.agent}`);
	if (node.model) chips.push(node.model.split("/").pop() || node.model);

	let body: string | null = null;
	let bodyClass = "pg-orch-preview";
	if (runNode) {
		if (status === "running") body = lastLines(runNode.preview, 3);
		else if (status === "ok") body = (runNode.output ?? "").slice(-200);
		else if (status === "error") {
			body = runNode.error ?? "";
			bodyClass += " pg-error-text";
		} else if (status === "skipped") body = runNode.skipReason ?? "";
	}

	return (
		<div className={`pg-node pg-orch-node pg-status-${status}`}>
			<Handle type="target" position={Position.Left} className="pg-handle" />
			<Handle type="source" position={Position.Right} className="pg-handle" />
			<div className="pg-node-head">
				{/* the kind slot the live canvas pins too (pg-icon) — a gate is
				 * material structure, so the mark is ink, never the amber state */}
				{node.gate && <span className="pg-icon pg-orch-gate-mark">门</span>}
				{status === "running" && <span className="pg-spinner" />}
				<b className="pg-title">{data.label}</b>
				<span className={`pg-dot pg-dot-${status}`} />
			</div>
			{chips.length > 0 && (
				<div className="pg-orch-chips">
					{chips.map((c) => (
						<span key={c} className="pg-chip">
							{c}
						</span>
					))}
				</div>
			)}
			{body ? <div className={bodyClass}>{body}</div> : null}
		</div>
	);
}

/** Module scope: React Flow diffs nodeTypes by identity. */
export const orchNodeTypes = { orch: OrchNode };

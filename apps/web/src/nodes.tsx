/**
 * Custom React Flow node components. One visual treatment per data.kind,
 * status-driven accent colors:
 *   running -> blue pulse / ok -> green / error -> red / pending -> gray
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNodeData } from "@pi-graph/shared";
import "./nodes.css";

type DataNodeProps = NodeProps & { data: GraphNodeData };

function StatusDot({ status }: { status: GraphNodeData["status"] }) {
	return <span className={`pg-dot pg-dot-${status}`} />;
}

function NodeShell({
	data,
	icon,
	children,
	className = "",
}: {
	data: GraphNodeData;
	icon: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={`pg-node pg-node-${data.kind} pg-status-${data.status} ${className}`}>
			<Handle type="target" position={Position.Left} className="pg-handle" />
			<Handle type="source" position={Position.Right} className="pg-handle" />
			<div className="pg-node-head">
				<span className="pg-icon">{icon}</span>
				{data.status === "running" && <span className="pg-spinner" />}
				<StatusDot status={data.status} />
			</div>
			{children}
		</div>
	);
}

export function SessionNode({ data }: DataNodeProps) {
	return (
		<NodeShell data={data} icon="◆">
			<div className="pg-title">pi session</div>
		</NodeShell>
	);
}

export function UserNode({ data }: DataNodeProps) {
	return (
		<NodeShell data={data} icon="👤">
			<div className="pg-label">{data.label}</div>
		</NodeShell>
	);
}

export function AssistantNode({ data }: DataNodeProps) {
	return (
		<NodeShell data={data} icon="🤖">
			<div className="pg-label">{data.label}</div>
		</NodeShell>
	);
}

export function ToolNode({ data }: DataNodeProps) {
	return (
		<NodeShell data={data} icon="🔧" className="pg-mono">
			<div className="pg-label">{data.label}</div>
		</NodeShell>
	);
}

export function SubagentCallNode({ data }: DataNodeProps) {
	return (
		<NodeShell data={data} icon="✳">
			<div className="pg-label">{data.label}</div>
		</NodeShell>
	);
}

export function AgentNode({ data }: DataNodeProps) {
	const detail = data.detail as { usage?: { turns: number; output: number }; model?: string } | undefined;
	return (
		<NodeShell data={data} icon="🛰">
			<div className="pg-title">{data.label}</div>
			{detail?.usage && (
				<div className="pg-sub">
					{detail.usage.turns} turns · ↓{detail.usage.output}
					{detail.model ? ` · ${detail.model.split("/").pop()}` : ""}
				</div>
			)}
		</NodeShell>
	);
}

export function AgentToolNode({ data }: DataNodeProps) {
	return (
		<NodeShell data={data} icon="·" className="pg-mono pg-dim">
			<div className="pg-label">{data.label}</div>
		</NodeShell>
	);
}

export const nodeTypes = {
	session: SessionNode,
	user: UserNode,
	assistant: AssistantNode,
	tool: ToolNode,
	"subagent-call": SubagentCallNode,
	agent: AgentNode,
	"agent-tool": AgentToolNode,
};

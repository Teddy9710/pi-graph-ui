/**
 * On-demand detail panel: renders the selected node's payload - full
 * message text / tool args+result / subagent task+summary+usage. App only
 * mounts it while a node is selected (no permanent placeholder); onClose
 * (×) clears the selection.
 */

import type {
	AssistantMessage,
	GraphNodeData,
	Message,
	SubagentSingleResult,
	ToolExecutionState,
	UserMessage,
} from "@pi-graph/shared";
import { NODE_KIND_LABEL, NODE_STATUS_LABEL } from "./status.ts";
import { useStore } from "./store.ts";

function MessageBody({ message }: { message: Message }) {
	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		return <pre className="pg-pre">{text}</pre>;
	}
	if (message.role === "assistant") {
		const m = message as AssistantMessage;
		return (
			<>
				{m.content.map((block, i) =>
					block.type === "text" ? (
						<pre key={i} className="pg-pre">
							{block.text}
						</pre>
					) : block.type === "thinking" ? (
						<details key={i}>
							<summary>thinking ({block.thinking.length} chars)</summary>
							<pre className="pg-pre pg-dim">{block.thinking}</pre>
						</details>
					) : (
						<pre key={i} className="pg-pre">
							→ {block.name}({JSON.stringify(block.arguments, null, 1)})
						</pre>
					),
				)}
				<div className="pg-meta">
					{m.model} · {m.stopReason} · ↓{m.usage.output} tok
				</div>
			</>
		);
	}
	const tr = message;
	return (
		<div>
			<div className="pg-meta">
				{tr.toolName} · {tr.isError ? "error" : "ok"}
			</div>
			<pre className="pg-pre">{tr.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")}</pre>
		</div>
	);
}

function ToolDetail({ tool }: { tool: ToolExecutionState }) {
	return (
		<div>
			<div className="pg-meta">
				{tool.toolName} · {tool.status}
				{tool.endedAt ? ` · ${((tool.endedAt - tool.startedAt) / 1000).toFixed(1)}s` : " · running…"}
			</div>
			<h4>args</h4>
			<pre className="pg-pre">{JSON.stringify(tool.args, null, 2)}</pre>
			{tool.partialResult != null && (
				<>
					<h4>partial</h4>
					<pre className="pg-pre pg-dim">{JSON.stringify(tool.partialResult, null, 2).slice(0, 4000)}</pre>
				</>
			)}
			{tool.result != null && (
				<>
					<h4>result</h4>
					<pre className="pg-pre">{JSON.stringify(tool.result, null, 2).slice(0, 8000)}</pre>
				</>
			)}
		</div>
	);
}

function AgentDetail({ result }: { result: SubagentSingleResult }) {
	const failed = result.exitCode !== 0 && result.exitCode !== -1;
	return (
		<div>
			<div className="pg-meta">
				{result.agent} ({result.agentSource}) · exit {result.exitCode}
				{result.model ? ` · ${result.model}` : ""}
				{result.stopReason ? ` · ${result.stopReason}` : ""}
			</div>
			<h4>task</h4>
			<pre className="pg-pre">{result.task}</pre>
			<h4>messages ({result.messages.length})</h4>
			{result.messages.map((m, i) => (
				<MessageBody key={i} message={m} />
			))}
			{failed && result.errorMessage && (
				<>
					<h4>error</h4>
					<pre className="pg-pre pg-error-text">{result.errorMessage}</pre>
				</>
			)}
			<h4>usage</h4>
			<pre className="pg-pre">{JSON.stringify(result.usage, null, 2)}</pre>
		</div>
	);
}

export function DetailPanel({ onClose }: { onClose?: () => void }) {
	// Resolve node ids against whatever graph the canvas is showing —
	// in history mode that's the archived graph, not the live one.
	const graph = useStore((s) => (s.history ? s.history.graph : s.graph));
	const selectedNodeId = useStore((s) => s.selectedNodeId);

	const node = graph.nodes.find((n) => n.id === selectedNodeId);
	if (!node) {
		return <aside className="pg-panel">点击节点查看详情</aside>;
	}
	const data: GraphNodeData = node.data;

	const kindMeta = NODE_KIND_LABEL[data.kind] ?? { icon: "", text: data.kind };
	return (
		<aside className="pg-panel">
			<header>
				<span className={`pg-dot pg-dot-${data.status}`} />
				{/* icon + Chinese kind + status text — the dot alone is color-only,
				    invisible to screen readers and red-green color blindness */}
				<b>
					{kindMeta.icon} {kindMeta.text}
				</b>
				<span className="pg-dim">{NODE_STATUS_LABEL[data.status] ?? data.status}</span>
				<code className="pg-dim">{node.id}</code>
				{onClose && (
					<button className="pg-drawer-close pg-panel-close" title="关闭详情" aria-label="关闭详情" onClick={onClose}>
						×
					</button>
				)}
			</header>
			{data.kind === "session" && (
				<pre className="pg-pre">{JSON.stringify(data.detail, null, 2)}</pre>
			)}
			{data.kind === "user" && <MessageBody message={data.detail as UserMessage} />}
			{data.kind === "assistant" && <MessageBody message={data.detail as AssistantMessage} />}
			{(data.kind === "tool" || data.kind === "subagent-call") && (
				<ToolDetail tool={data.detail as ToolExecutionState} />
			)}
			{data.kind === "agent" &&
				(data.detail ? (
					<AgentDetail result={(data.detail as { result: SubagentSingleResult }).result} />
				) : (
					<p className="pg-dim">暂无详情（子代理运行结束后回填）</p>
				))}
			{data.kind === "agent-tool" && (
				<pre className="pg-pre">{JSON.stringify(data.detail, null, 2)}</pre>
			)}
		</aside>
	);
}

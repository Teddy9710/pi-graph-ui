/**
 * Right panel of the orchestrate page. With a node selected: edit its fields
 * (id is read-only — it's the identity edges reference), delete it, and
 * inspect its run results (status/duration, assembledPrompt, final output,
 * usage, error). With nothing selected: graph-level validation issues, node
 * and edge counts, and usage hints.
 */

import { useEffect, useState } from "react";
import { API_BASE } from "./store.ts";
import { useOrchStore } from "./orch-store.ts";

/** GET /api/agents → persona names for the agent datalist. Tolerates both
 *  string[] and {name}[] shapes; failure just leaves the list empty. */
function useAgentNames(): string[] {
	const [agents, setAgents] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		fetch(`${API_BASE}/api/agents`)
			.then((res) => (res.ok ? (res.json() as Promise<unknown>) : []))
			.then((list) => {
				if (cancelled || !Array.isArray(list)) return;
				setAgents(
					list
						.map((a) =>
							typeof a === "string"
								? a
								: typeof a === "object" && a !== null && typeof (a as { name?: unknown }).name === "string"
									? (a as { name: string }).name
									: "",
						)
						.filter(Boolean),
				);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return agents;
}

function GraphSummary() {
	const graphDef = useOrchStore((s) => s.graphDef);
	const issues = useOrchStore((s) => s.issues);
	return (
		<aside className="pg-panel">
			<header>
				<b>图概览</b>
				<span className="pg-dim">
					{graphDef.nodes.length} 节点 · {graphDef.edges.length} 边
				</span>
			</header>
			<h4>校验（{issues.length} 个问题）</h4>
			{issues.length === 0 ? (
				<p className="pg-dim">图有效，可以运行。</p>
			) : (
				issues.map((issue, i) => (
					<div key={i} className="pg-meta pg-error-text">
						{issue.nodeOrEdge ? `${issue.nodeOrEdge}：` : ""}
						{issue.message}
					</div>
				))
			)}
			<h4>提示</h4>
			<p className="pg-dim">
				点击节点选中后再编辑；从节点右侧圆点拖到另一节点左侧圆点连线（环会被拒绝）；删除键删除选中节点；「自动整理」用 dagre 重排全部节点。
			</p>
		</aside>
	);
}

export function OrchNodePanel() {
	const graphDef = useOrchStore((s) => s.graphDef);
	const selectedNodeId = useOrchStore((s) => s.selectedNodeId);
	const run = useOrchStore((s) => s.run);
	const updateNode = useOrchStore((s) => s.updateNode);
	const deleteNode = useOrchStore((s) => s.deleteNode);
	const agents = useAgentNames();

	const node = selectedNodeId ? (graphDef.nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
	if (!node) return <GraphSummary />;

	const runNode = selectedNodeId ? (run.nodes[selectedNodeId] ?? null) : null;
	const running = run.status === "running";
	const duration =
		runNode?.startedAt != null && runNode.endedAt != null
			? ` · ${((runNode.endedAt - runNode.startedAt) / 1000).toFixed(1)}s`
			: runNode?.status === "running"
				? " · …"
				: "";

	return (
		<aside className="pg-panel">
			<header>
				<span className={`pg-dot pg-dot-${runNode?.status ?? "pending"}`} />
				<b>{node.label || node.id}</b>
				{/* The id is the identity every edge references — read-only. */}
				<code className="pg-dim">{node.id}</code>
			</header>
			<div className="pg-form-row">
				<label htmlFor="pg-node-label">label</label>
				<input
					id="pg-node-label"
					className="pg-form-input"
					value={node.label ?? ""}
					disabled={running}
					onChange={(e) => updateNode(node.id, { label: e.target.value })}
				/>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-node-task">task（任务 prompt，上游输出会自动追加）</label>
				<textarea
					id="pg-node-task"
					className="pg-form-input"
					value={node.task}
					disabled={running}
					onChange={(e) => updateNode(node.id, { task: e.target.value })}
				/>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-node-model">model</label>
				<input
					id="pg-node-model"
					className="pg-form-input"
					placeholder="deepseek/deepseek-chat"
					value={node.model ?? ""}
					disabled={running}
					onChange={(e) => updateNode(node.id, { model: e.target.value })}
				/>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-node-agent">agent（persona）</label>
				<input
					id="pg-node-agent"
					className="pg-form-input"
					list="pg-agents"
					value={node.agent ?? ""}
					disabled={running}
					onChange={(e) => updateNode(node.id, { agent: e.target.value })}
				/>
				<datalist id="pg-agents">
					{agents.map((a) => (
						<option key={a} value={a} />
					))}
				</datalist>
			</div>
			<button className="pg-btn pg-btn-danger" disabled={running} onClick={() => deleteNode(node.id)}>
				删除节点
			</button>

			{runNode && (
				<>
					<h4>运行</h4>
					<div className="pg-meta">
						{runNode.status}
						{duration}
						{runNode.model ? ` · ${runNode.model}` : ""}
						{runNode.stopReason ? ` · ${runNode.stopReason}` : ""}
					</div>
					{runNode.assembledPrompt != null && (
						<details>
							<summary>assembledPrompt（{runNode.assembledPrompt.length} 字符）</summary>
							<pre className="pg-pre">{runNode.assembledPrompt}</pre>
						</details>
					)}
					{runNode.output != null && (
						<>
							<h4>最终输出</h4>
							<pre className="pg-pre">{runNode.output}</pre>
						</>
					)}
					{runNode.usage && (
						<div className="pg-meta">
							↑{runNode.usage.input} ↓{runNode.usage.output} · {runNode.usage.totalTokens} tok · $
							{runNode.usage.cost.toFixed(4)}
						</div>
					)}
					{runNode.error && <pre className="pg-pre pg-error-text">{runNode.error}</pre>}
					{runNode.status === "skipped" && runNode.skipReason && (
						<div className="pg-dim">跳过：{runNode.skipReason}</div>
					)}
				</>
			)}
		</aside>
	);
}

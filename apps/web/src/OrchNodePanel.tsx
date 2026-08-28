/**
 * Right panel of the orchestrate page. With a node selected: edit its fields
 * (id is read-only — it's the identity edges reference), delete it, and
 * inspect its run results (status/duration, assembledPrompt, final output,
 * usage, error). With nothing selected: graph-level validation issues, node
 * and edge counts, and usage hints.
 */

import { useEffect, useState } from "react";
import {
	EDGE_TYPES,
	EDGE_TYPE_LABELS,
	MAX_EDGE_NOTE_CHARS,
	type EdgeDef,
	type EdgeType,
} from "@pi-graph/shared";
import { API_BASE } from "./store.ts";
import { RUN_NODE_STATUS_LABEL } from "./status.ts";
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

/** Edge inspector: the TYPE (fixed vocabulary — the edge's execution
 *  semantics) plus the optional short note and deletion. Read-only wherever
 *  the graph isn't editable (run view, mid-run). */
function EdgePanel({ edge, editable }: { edge: EdgeDef; editable: boolean }) {
	const updateEdgeType = useOrchStore((s) => s.updateEdgeType);
	const updateEdgeLabel = useOrchStore((s) => s.updateEdgeLabel);
	const deleteEdge = useOrchStore((s) => s.deleteEdge);
	return (
		<aside className="pg-panel">
			<header>
				<b>边</b>
				<code className="pg-dim">
					{edge.source} → {edge.target}
				</code>
			</header>
			<div className="pg-form-row">
				<label htmlFor="pg-edge-type">类型（这条边的执行语义）</label>
				{/* value falls back to "input" — old graphs without a type still
				    show (and keep) the default rather than a blank select. */}
				<select
					id="pg-edge-type"
					className="pg-form-input"
					value={edge.type ?? "input"}
					disabled={!editable}
					onChange={(e) => updateEdgeType(edge.id, e.target.value as EdgeType)}
				>
					{EDGE_TYPES.map((t) => (
						<option key={t} value={t}>
							{EDGE_TYPE_LABELS[t]}（{t}）
						</option>
					))}
				</select>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-edge-label">备注（可选，类型说不清时补充，≤{MAX_EDGE_NOTE_CHARS} 字）</label>
				<input
					id="pg-edge-label"
					className="pg-form-input"
					placeholder="如：原始数据"
					maxLength={MAX_EDGE_NOTE_CHARS}
					value={edge.label ?? ""}
					disabled={!editable}
					onChange={(e) => updateEdgeLabel(edge.id, e.target.value)}
				/>
			</div>
			<p className="pg-dim">运行时以「### from 上游id —— 类型徽章（备注）」的头部随上游输出注入下游任务的 prompt。</p>
			{editable ? (
				<button className="pg-btn pg-btn-danger pg-btn-sm" onClick={() => deleteEdge(edge.id)}>
					删除边
				</button>
			) : (
				<div className="pg-dim">当前视图只读——「转入编辑器」后可修改</div>
			)}
		</aside>
	);
}

function GraphSummary() {
	const graphDef = useOrchStore((s) => s.graphDef);
	const issues = useOrchStore((s) => s.issues);
	const run = useOrchStore((s) => s.run);
	const view = useOrchStore((s) => s.view);
	const shown = view === "run" ? run.graph : graphDef;
	return (
		<aside className="pg-panel">
			<header>
				<b>{view === "run" ? "运行图" : "图概览"}</b>
				<span className="pg-dim">
					{shown ? `${shown.nodes.length} 节点 · ${shown.edges.length} 边` : "尚未生成"}
				</span>
			</header>
			{run.goal && (
				<>
					<h4>目标</h4>
					<p className="pg-dim">{run.goal}</p>
				</>
			)}
			{run.planError && <div className="pg-meta pg-error-text">{run.planError}</div>}
			{view === "editor" && (
				<>
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
				</>
			)}
			<h4>提示</h4>
			<p className="pg-dim">
				{view === "run"
					? "点击节点查看运行详情，边上的徽章标注依赖语义（输入/参考/审校/修订/汇总/决策）；「转入编辑器」把生成图复制到编辑器后可修改再跑。"
					: "点击节点选中后编辑，点击边可查看/修改类型与备注；从节点右侧圆点拖到另一节点左侧圆点连线（默认输入类型，环会被拒绝）；删除键删除选中节点；「自动整理」用 dagre 重排全部节点。"}
			</p>
		</aside>
	);
}

export function OrchNodePanel() {
	const graphDef = useOrchStore((s) => s.graphDef);
	const selectedNodeId = useOrchStore((s) => s.selectedNodeId);
	const selectedEdgeId = useOrchStore((s) => s.selectedEdgeId);
	const run = useOrchStore((s) => s.run);
	const view = useOrchStore((s) => s.view);
	const updateNode = useOrchStore((s) => s.updateNode);
	const deleteNode = useOrchStore((s) => s.deleteNode);
	const agents = useAgentNames();

	// In the run view the inspected node belongs to the GENERATED graph, not
	// the editor's — fields render read-only there.
	const source = view === "run" ? run.graph : graphDef;
	const node = selectedNodeId ? (source?.nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
	if (!node && selectedEdgeId) {
		const edge = source?.edges.find((e) => e.id === selectedEdgeId) ?? null;
		if (edge) return <EdgePanel edge={edge} editable={view === "editor" && run.status !== "running"} />;
	}
	if (!node) return <GraphSummary />;

	const runNode = selectedNodeId ? (run.nodes[selectedNodeId] ?? null) : null;
	const editable = view === "editor" && run.status !== "running";
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
				{/* Status in words, not just the colored dot */}
				<span className="pg-dim">{RUN_NODE_STATUS_LABEL[runNode?.status ?? "pending"] ?? runNode?.status}</span>
				{/* The id is the identity every edge references — read-only. */}
				<code className="pg-dim">{node.id}</code>
			</header>
			<div className="pg-form-row">
				<label htmlFor="pg-node-label">label</label>
				<input
					id="pg-node-label"
					className="pg-form-input"
					value={node.label ?? ""}
					disabled={!editable}
					onChange={(e) => updateNode(node.id, { label: e.target.value })}
				/>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-node-task">task（任务 prompt，上游输出会自动追加）</label>
				<textarea
					id="pg-node-task"
					className="pg-form-input"
					value={node.task}
					disabled={!editable}
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
					disabled={!editable}
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
					disabled={!editable}
					onChange={(e) => updateNode(node.id, { agent: e.target.value })}
				/>
				<datalist id="pg-agents">
					{agents.map((a) => (
						<option key={a} value={a} />
					))}
				</datalist>
			</div>
			{editable ? (
				<button className="pg-btn pg-btn-danger pg-btn-sm" onClick={() => deleteNode(node.id)}>
					删除节点
				</button>
			) : (
				<div className="pg-dim">运行视图只读——「转入编辑器」后可修改</div>
			)}

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

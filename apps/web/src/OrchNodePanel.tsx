/**
 * Right panel of the orchestrate page. With a node selected: edit its fields
 * (id is read-only — it's the identity edges reference), delete it, and
 * inspect its run results (status/duration, assembledPrompt, final output,
 * usage, error). With nothing selected: graph-level validation issues, node
 * and edge counts, and usage hints.
 */

import { useEffect, useState } from "react";
import {
	buildRunExport,
	EDGE_TYPES,
	EDGE_TYPE_LABELS,
	MAX_EDGE_NOTE_CHARS,
	MAX_NODE_RETRIES,
	type EdgeDef,
	type EdgeType,
} from "@pi-graph/shared";
import { API_BASE } from "./store.ts";
import { Icon } from "./icons.tsx";
import { RUN_NODE_STATUS_LABEL } from "./status.ts";
import { useOrchStore } from "./orch-store.ts";
import {
	copyText,
	downloadJson,
	exportGraphToJson,
	graphExportFilename,
	runExportFilename,
} from "./export-utils.ts";

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

	async function copyShown() {
		if (!shown) return;
		try {
			await copyText(exportGraphToJson(shown));
		} catch {
			// Errors are transient; the toolbar already shows copy failures.
		}
	}
	function downloadShown() {
		if (!shown) return;
		downloadJson(exportGraphToJson(shown), graphExportFilename(shown));
	}
	async function copyRunExport() {
		if (run.status === "idle") return;
		try {
			await copyText(JSON.stringify(buildRunExport(run), null, 2));
		} catch {
			// Ignore.
		}
	}
	function downloadRunExport() {
		if (run.status === "idle") return;
		downloadJson(JSON.stringify(buildRunExport(run), null, 2), runExportFilename(buildRunExport(run)));
	}

	return (
		<aside className="pg-panel">
			<header>
				<b>{view === "run" ? "运行图" : "图概览"}</b>
				<span className="pg-dim">
					{shown ? `${shown.nodes.length} 节点 · ${shown.edges.length} 边` : "尚未生成"}
				</span>
				{shown && (
					<span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
						<button className="pg-session-act" title="复制图为 JSON" onClick={copyShown}>
							<Icon name="copy" size={14} />
						</button>
						<button className="pg-session-act" title="下载图为 JSON" onClick={downloadShown}>
							<Icon name="download" size={14} />
						</button>
					</span>
				)}
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
			{run.status !== "idle" && (
				<>
					<h4>运行结果</h4>
					<div className="pg-form-row" style={{ gap: 6 }}>
						<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={copyRunExport}>
							<Icon name="copy" size={13} /> 复制运行 JSON
						</button>
						<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={downloadRunExport}>
							<Icon name="download" size={13} /> 下载运行 JSON
						</button>
					</div>
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
	const approveNode = useOrchStore((s) => s.approveNode);
	const repairNode = useOrchStore((s) => s.repairNode);
	const agents = useAgentNames();
	const runNode = selectedNodeId ? (run.nodes[selectedNodeId] ?? null) : null;
	// The note belongs to ONE gate decision — switching nodes, a settled
	// decision (the status leaves "awaiting": decided/aborted) or a new run
	// must not leak it into the next gate's input. NOT cleared on click: if
	// the send is still in flight (or dropped mid-reconnect) the reviewer's
	// typed note survives for the retry.
	const [gateNote, setGateNote] = useState("");
	useEffect(() => {
		setGateNote("");
	}, [selectedNodeId, run.runId, runNode?.status]);

	// In the run view the inspected node belongs to the GENERATED graph, not
	// the editor's — fields render read-only there.
	const source = view === "run" ? run.graph : graphDef;
	const node = selectedNodeId ? (source?.nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
	if (!node && selectedEdgeId) {
		const edge = source?.edges.find((e) => e.id === selectedEdgeId) ?? null;
		if (edge) return <EdgePanel edge={edge} editable={view === "editor" && run.status !== "running"} />;
	}
	if (!node) return <GraphSummary />;

	const editable = view === "editor" && run.status !== "running";
	const gate = node.gate === true;
	const awaiting = runNode?.status === "awaiting";
	const duration =
		runNode?.startedAt != null && runNode.endedAt != null
			? ` · ${((runNode.endedAt - runNode.startedAt) / 1000).toFixed(1)}s`
			: runNode?.status === "running" || awaiting
				? " · …"
				: "";

	return (
		<aside className="pg-panel">
			<header>
				<span className={`pg-dot pg-dot-${runNode?.status ?? "pending"}`} />
				<b>{node.label || node.id}</b>
				{/* Status in words, not just the colored dot. awaiting predates
				 * status.ts's label map — spell it here instead of showing the raw enum. */}
				<span className="pg-dim">
					{runNode?.status === "awaiting" ? "待审批" : (RUN_NODE_STATUS_LABEL[runNode?.status ?? "pending"] ?? runNode?.status)}
				</span>
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
				<label htmlFor="pg-node-task">
					{gate ? "task（审校要点，挂起时连同上游输入一起展示给审阅者）" : "task（任务 prompt，上游输出会自动追加）"}
				</label>
				<textarea
					id="pg-node-task"
					className="pg-form-input"
					value={node.task}
					disabled={!editable}
					onChange={(e) => updateNode(node.id, { task: e.target.value })}
				/>
			</div>
			{/* A gate never reaches an executor — its exec config (model/agent)
			 * would be rejected by validateGraph, so the fields don't render at all. */}
			{!gate && (
				<>
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
					<div className="pg-form-row">
						<label htmlFor="pg-node-retries">失败自动重试（0-{MAX_NODE_RETRIES}，留空 = 服务器默认；仅超时/进程/模型类失败）</label>
						<input
							id="pg-node-retries"
							className="pg-form-input"
							type="number"
							min={0}
							max={MAX_NODE_RETRIES}
							value={node.maxRetries ?? ""}
							disabled={!editable}
							onChange={(e) => {
								const v = e.target.value;
								updateNode(node.id, { maxRetries: v === "" ? undefined : Number(v) });
							}}
						/>
					</div>
				</>
			)}
			{gate && (
				<>
					<h4>人工门控</h4>
					{awaiting ? (
						<>
							<p className="pg-dim">运行已挂起，等待审校。待审内容：</p>
							<pre className="pg-pre">{runNode?.assembledPrompt ?? node.task}</pre>
							<div className="pg-form-row">
								<label htmlFor="pg-gate-note">备注（批准时注入下游，驳回时作为理由，≤2000 字）</label>
								<input
									id="pg-gate-note"
									className="pg-form-input"
									maxLength={2000}
									value={gateNote}
									onChange={(e) => setGateNote(e.target.value)}
								/>
							</div>
						</>
					) : (
						<p className="pg-dim">运行到此节点会挂起，等人工批准后下游才继续；驳回按失败传播（下游跳过）。</p>
					)}
					<div className="pg-gate-actions">
						{/* 批准 is the GO stamp (primary ink); both keys idle outside
						    awaiting — the store guard double-checks before sending.
						    The note is NOT cleared here: the status effect clears it
						    once the decision settles (or it stays for a retry). */}
						<button className="pg-btn" disabled={!awaiting} onClick={() => approveNode(node.id, true, gateNote)}>
							批准
						</button>
						<button
							className="pg-btn pg-btn-danger"
							disabled={!awaiting}
							onClick={() => approveNode(node.id, false, gateNote)}
						>
							驳回
						</button>
					</div>
				</>
			)}
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
					{/* Live auto-retry status: an intermediate attempt failed but the
					 * node re-executes (a retry that succeeds never failed). */}
					{runNode.retry && (
						<div className="pg-meta" title={runNode.retry.lastError}>
							<Icon name="rerun" size={11} /> 自动重试 {runNode.retry.attempt}/{runNode.retry.maxAttempts}
							{runNode.retry.lastError ? ` · 上次错误：${runNode.retry.lastError.slice(0, 200)}` : ""}
						</div>
					)}
					{runNode.reusedFrom && <div className="pg-dim">复用自 {runNode.reusedFrom}（本次未重新执行）</div>}
					{/* 产物目录：本运行该节点的专属文件夹（工作目录 + output.md 归档）。
					    overflowWrap 防 Windows 长路径撑爆面板；title 悬停看全路径；
					    旧归档/功能未开时为 null 不渲染。 */}
					{runNode.artifactDir && (
						<div className="pg-dim" title={runNode.artifactDir}>
							产物目录：<code style={{ overflowWrap: "anywhere" }}>{runNode.artifactDir}</code>
						</div>
					)}
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
					{/* AI 修复: only a FAILED node of a TERMINAL run qualifies (the
					 * store guard double-checks); gates are excluded — a rejection is
					 * a human decision, not something the planner may rewrite. */}
					{runNode.status === "error" && !gate && (run.status === "failed" || run.status === "aborted") && (
						<button
							className="pg-btn pg-btn-sm"
							title="AI 结合失败原因与上游输出重写该节点的任务（可调整模型/工具），复用其余节点输出后重跑"
							onClick={() => repairNode(node.id)}
						>
							AI 修复并重跑
						</button>
					)}
					{runNode.status === "skipped" && runNode.skipReason && (
						<div className="pg-dim">跳过：{runNode.skipReason}</div>
					)}
				</>
			)}
		</aside>
	);
}

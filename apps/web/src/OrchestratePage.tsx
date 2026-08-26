/**
 * 编排 tab. Two bars above the canvas + node panel:
 *  - 目标 bar: type ONE goal → ⚡自动编排 — the server's planner decomposes it
 *    into a task DAG and runs it immediately (the run view materializes as the
 *    plan streams in); while planning, the drafted plan JSON previews live;
 *  - run bar: the manual editor controls (template picker, auto-arrange, add
 *    node, run/abort, run summary chips, issue badge, error lines).
 * The canvas below switches between the editable graphDef (editor view) and
 * the read-only generated run graph (run view).
 */

import { useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { TEMPLATES } from "@pi-graph/shared";
import { OrchCanvas } from "./OrchCanvas.tsx";
import { OrchNodePanel } from "./OrchNodePanel.tsx";
import { useOrchStore } from "./orch-store.ts";

function PlanBar() {
	const run = useOrchStore((s) => s.run);
	const view = useOrchStore((s) => s.view);
	const planRun = useOrchStore((s) => s.planRun);
	const setView = useOrchStore((s) => s.setView);
	const importGraphFromRun = useOrchStore((s) => s.importGraphFromRun);
	const abortRun = useOrchStore((s) => s.abortRun);
	const [goal, setGoal] = useState("");

	const busy = run.status === "running" || run.status === "planning";
	const planning = run.status === "planning";
	const trimmed = goal.trim();
	// The plan JSON drafts tail-first; one dim line is enough as a pulse.
	const planTail = run.planText.length > 0 ? run.planText.slice(-160).replace(/\s+/g, " ") : "";

	return (
		<div className="pg-orch-bar pg-orch-goal">
			<input
				className="pg-form-input pg-orch-goal-input"
				placeholder="描述一个目标，AI 自动拆成任务图并执行，例如：调研 React、Vue、Svelte 三者的优缺点并汇总成对比表"
				value={goal}
				disabled={busy}
				onChange={(e) => setGoal(e.target.value)}
				onKeyDown={(e) => {
					// IME composition Enter (committing pinyin candidates, Safari
					// reports it as key="Enter") must not submit the goal.
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter" && trimmed && !busy) planRun(trimmed);
				}}
			/>
			<button
				className="pg-btn pg-btn-sm"
				disabled={busy || !trimmed}
				title="规划器把目标拆成任务 DAG 并立即执行"
				onClick={() => planRun(trimmed)}
			>
				{planning ? "规划中…" : "⚡ 自动编排"}
			</button>
			{planning && (
				<button className="pg-btn pg-btn-danger pg-btn-sm" onClick={abortRun}>
					⏹ 中止
				</button>
			)}
			{view === "editor" ? (
				run.status !== "idle" && (
					<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={() => setView("run")}>
						查看运行
					</button>
				)
			) : (
				<>
					<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={() => setView("editor")}>
						返回编辑器
					</button>
					<button
						className="pg-btn pg-btn-ghost pg-btn-sm"
						disabled={busy || !run.graph}
						title="把生成的图复制到编辑器，可修改后手动重跑"
						onClick={importGraphFromRun}
					>
						转入编辑器
					</button>
				</>
			)}
			{planning && planTail && (
				<span className="pg-orch-plan-tail" title={run.planText.slice(-2000)}>
					{planTail}
				</span>
			)}
			{run.planError && <span className="pg-error-text">{run.planError}</span>}
		</div>
	);
}

function OrchRunBar() {
	const issues = useOrchStore((s) => s.issues);
	const run = useOrchStore((s) => s.run);
	const view = useOrchStore((s) => s.view);
	const connectIssue = useOrchStore((s) => s.connectIssue);
	const orchError = useOrchStore((s) => s.orchError);
	const applyTemplate = useOrchStore((s) => s.applyTemplate);
	const autoArrange = useOrchStore((s) => s.autoArrange);
	const addNode = useOrchStore((s) => s.addNode);
	const clearCanvas = useOrchStore((s) => s.clearCanvas);
	const runGraph = useOrchStore((s) => s.runGraph);
	const abortRun = useOrchStore((s) => s.abortRun);
	const [tpl, setTpl] = useState("");

	const running = run.status === "running";
	const planning = run.status === "planning";
	const busy = running || planning;
	// Editor-mutating controls are inert while the run view is showing —
	// they'd edit a canvas the user cannot see.
	const editLocked = busy || view === "run";
	const issueTitle = issues.map((i) => (i.nodeOrEdge ? `${i.nodeOrEdge}：` : "") + i.message).join("\n");
	const elapsed = run.startedAt != null ? ((run.finishedAt ?? Date.now()) - run.startedAt) / 1000 : null;

	return (
		<div className="pg-orch-bar">
			<select
				value={tpl}
				title="套用内置模板（会替换当前画布内容）"
				disabled={editLocked}
				onChange={(e) => {
					const key = e.target.value;
					if (key) applyTemplate(key);
					// The canvas now holds an editable copy — snap back to 保持当前.
					setTpl("");
				}}
			>
				<option value="">保持当前</option>
				{TEMPLATES.map((t) => (
					<option key={t.key} value={t.key}>
						{t.name}
					</option>
				))}
			</select>
			<button className="pg-btn pg-btn-ghost pg-btn-sm" disabled={editLocked} onClick={autoArrange}>
				自动整理
			</button>
			<button className="pg-btn pg-btn-ghost pg-btn-sm" disabled={editLocked} onClick={addNode}>
				＋节点
			</button>
			<button
				className="pg-btn pg-btn-ghost pg-btn-sm"
				disabled={editLocked}
				title="清空画布（不可撤销）"
				onClick={clearCanvas}
			>
				清空
			</button>
			<button
				className="pg-btn pg-btn-sm"
				disabled={(issues.length > 0 && !running) || busy}
				title={issueTitle || "运行整张图"}
				onClick={runGraph}
			>
				▶ 运行
			</button>
			<button className="pg-btn pg-btn-danger pg-btn-sm" disabled={!busy} onClick={abortRun}>
				⏹ 中止
			</button>
			{issues.length > 0 && view === "editor" && (
				<span className="pg-orch-chip pg-error-text" title={issueTitle}>
					⚠ {issues.length} 个问题
				</span>
			)}
			{connectIssue && <span className="pg-error-text">{connectIssue}</span>}
			{run.status !== "idle" && (
				<>
					<span className="pg-orch-chip">{run.status}</span>
					<span className="pg-orch-chip">
						ok {run.ok} · 失败 {run.failed} · 跳过 {run.skipped}
					</span>
					<span className="pg-orch-chip">{run.usage.totalTokens} tok</span>
					{elapsed != null && <span className="pg-orch-chip">{elapsed.toFixed(1)}s</span>}
				</>
			)}
			{orchError && (
				<span className="pg-error-text" title={orchError.issues.map((i) => i.message).join("\n")}>
					{orchError.message}
				</span>
			)}
		</div>
	);
}

export function OrchestratePage() {
	const layout = useDefaultLayout({ id: "pg-orch-main", storage: localStorage });
	return (
		<div className="pg-app pg-orch-page">
			<PlanBar />
			<OrchRunBar />
			<div className="pg-main">
				{/* canvas | node-inspector split is drag-resizable, remembered in localStorage */}
				<Group orientation="horizontal" className="pg-pgroup" {...layout}>
					<Panel id="canvas" className="pg-fill" defaultSize="72" minSize={360}>
						<div className="pg-canvas">
							<OrchCanvas />
						</div>
					</Panel>
					<Separator className="pg-rh pg-rh-col" />
					<Panel id="inspector" className="pg-fill" defaultSize="28" minSize={300}>
						<OrchNodePanel />
					</Panel>
				</Group>
			</div>
		</div>
	);
}

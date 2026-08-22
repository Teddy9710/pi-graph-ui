/**
 * 编排 tab: run bar (template picker, auto-arrange, add node, run/abort, run
 * summary chips, issue badge, error lines) above the editor canvas + node
 * panel. Reuses pg-app/pg-main/pg-canvas so it stacks inside the app shell
 * under the header exactly like the live tab.
 */

import { useState } from "react";
import { TEMPLATES } from "@pi-graph/shared";
import { OrchCanvas } from "./OrchCanvas.tsx";
import { OrchNodePanel } from "./OrchNodePanel.tsx";
import { useOrchStore } from "./orch-store.ts";

function OrchRunBar() {
	const issues = useOrchStore((s) => s.issues);
	const run = useOrchStore((s) => s.run);
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
	const issueTitle = issues.map((i) => (i.nodeOrEdge ? `${i.nodeOrEdge}：` : "") + i.message).join("\n");
	const elapsed = run.startedAt != null ? ((run.finishedAt ?? Date.now()) - run.startedAt) / 1000 : null;

	return (
		<div className="pg-orch-bar">
			<select
				value={tpl}
				title="套用内置模板（会替换当前画布内容）"
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
			<button className="pg-btn pg-btn-ghost pg-btn-sm" disabled={running} onClick={autoArrange}>
				自动整理
			</button>
			<button className="pg-btn pg-btn-ghost pg-btn-sm" disabled={running} onClick={addNode}>
				＋节点
			</button>
			<button
				className="pg-btn pg-btn-ghost pg-btn-sm"
				disabled={running}
				title="清空画布（不可撤销）"
				onClick={clearCanvas}
			>
				清空
			</button>
			<button
				className="pg-btn pg-btn-sm"
				disabled={issues.length > 0 && !running}
				title={issueTitle || "运行整张图"}
				onClick={runGraph}
			>
				▶ 运行
			</button>
			<button className="pg-btn pg-btn-danger pg-btn-sm" disabled={!running} onClick={abortRun}>
				⏹ 中止
			</button>
			{issues.length > 0 && (
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
	return (
		<div className="pg-app pg-orch-page">
			<OrchRunBar />
			<div className="pg-main">
				<div className="pg-canvas">
					<OrchCanvas />
				</div>
				<OrchNodePanel />
			</div>
		</div>
	);
}

/**
 * App shell: header (tabs + connection + usage) and two tabs — 实时 (chat-first
 * live page: conversation as the main area, a mini live-trace graph in the side
 * column; node details appear on demand above it while a node is selected) and
 * 编排 (graph orchestration editor). Every pane boundary is user-resizable
 * (react-resizable-panels, layout remembered in localStorage). HistoryDrawer
 * stays mounted at app level.
 */

import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { ChatPanel } from "./ChatPanel.tsx";
import { DetailPanel } from "./DetailPanel.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { HistoryDrawer } from "./HistoryDrawer.tsx";
import { OrchestratePage } from "./OrchestratePage.tsx";
import { useOrchStore } from "./orch-store.ts";
import { connect, useStore } from "./store.ts";
import "./app.css";

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

type Tab = "live" | "orch";

function Header({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
	const wsStatus = useStore((s) => s.wsStatus);
	const session = useStore((s) => s.session);
	const piExit = useStore((s) => s.piExit);
	const history = useStore((s) => s.history);
	const openHistory = useStore((s) => s.openHistory);
	const exitHistory = useStore((s) => s.exitHistory);
	const statusText =
		wsStatus === "open"
			? "● connected"
			: wsStatus === "reconnecting"
				? "● reconnecting…"
				: wsStatus === "connecting"
					? "● connecting…"
					: "● disconnected";
	return (
		<header className="pg-header">
			<b className="pg-logo">pi-graph</b>
			<button className={`pg-tab${tab === "live" ? " active" : ""}`} onClick={() => setTab("live")}>
				实时
			</button>
			<button className={`pg-tab${tab === "orch" ? " active" : ""}`} onClick={() => setTab("orch")}>
				编排
			</button>
			{history ? (
				<span className="pg-history-banner">
					📜 历史回放
					{history.loading ? "（加载中…）" : ""}
					<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={exitHistory}>
						返回实时
					</button>
				</span>
			) : (
				<span className={`pg-ws pg-ws-${wsStatus}`}>{statusText}</span>
			)}
			{!history && (
				<>
					<span className="pg-dim">
						{session.agentStatus === "running" ? "agent running…" : "agent idle"}
					</span>
					<span className="pg-dim pg-usage">
						↑{formatTokens(session.usageTotal.input)} ↓{formatTokens(session.usageTotal.output)} tok
					</span>
				</>
			)}
			{session.lastError && !history && <span className="pg-error-text">{session.lastError.slice(0, 80)}</span>}
			{piExit && (
				<span className="pg-error-text" title={piExit.stderr.slice(-500)}>
					pi exited (code {piExit.code ?? "?"}) — 检查 bridge server
				</span>
			)}
			<button className="pg-btn pg-btn-ghost pg-btn-sm pg-history-btn" onClick={() => void openHistory()}>
				历史
			</button>
		</header>
	);
}

/**
 * Prompt input with the ⚡ auto-orchestration toggle.
 *
 * Decision matrix (deliberate, see PLAN.md M-C):
 *  - ⚡ OFF → exactly the historical behavior (send / steer / abort).
 *  - ⚡ ON  → Enter/「⚡ 编排」 sends the text as a plan_run goal (chat: true);
 *    the orchestration card + the integrated answer land in the chat column.
 *  - ⚡ ON while a SESSION run is active is allowed: the post-run injection
 *    prompt queues behind the current turn (pi's own queue_update), so the
 *    user can fire a goal without waiting for the session agent to settle.
 *  - ⚡ ON while an ORCHESTRATION is busy → input disabled (single-run
 *    server contract);「⏹ 中止编排」 aborts it.
 */
function PromptBar() {
	const [text, setText] = useState("");
	const [bolt, setBolt] = useState(false);
	const session = useStore((s) => s.session);
	const sendPrompt = useStore((s) => s.sendPrompt);
	const steer = useStore((s) => s.steer);
	const abort = useStore((s) => s.abort);
	const newSession = useStore((s) => s.newSession);
	const history = useStore((s) => s.history);
	const run = useOrchStore((s) => s.run);
	const planRun = useOrchStore((s) => s.planRun);
	const abortRun = useOrchStore((s) => s.abortRun);
	const running = session.agentStatus === "running";
	const orchBusy = run.status === "running" || run.status === "planning";

	if (history) {
		return (
			<footer className="pg-input-bar">
				<input disabled placeholder="正在查看历史回放，返回实时后可继续对话" />
			</footer>
		);
	}

	const placeholder = bolt
		? orchBusy
			? "编排进行中… 可中止后重新发起"
			: "描述一个目标，⚡ 自动拆图编排并执行…"
		: running
			? "运行中… 输入内容可插入转向指令 (steer)"
			: "给 pi agent 发一个任务…";

	const submit = () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (bolt) {
			// Busy: keep the text — the guard is silent and the user typed
			// something worth not losing (abort first, then re-send).
			if (orchBusy) return;
			planRun(trimmed, { chat: true });
		} else if (running) {
			steer(trimmed);
		} else {
			sendPrompt(trimmed);
		}
		setText("");
	};

	return (
		<footer className="pg-input-bar">
			<button
				className={`pg-btn pg-btn-ghost pg-bolt${bolt ? " pg-bolt-on" : ""}`}
				aria-pressed={bolt}
				title={bolt ? "⚡ 开启中：发送的内容将作为编排目标" : "开启 ⚡ 自动编排：发送目标 → 自动拆图执行 → 结果整理回对话"}
				onClick={() => setBolt((v) => !v)}
			>
				⚡
			</button>
			{!running && !bolt && (
				<button className="pg-btn pg-btn-ghost" title="清空当前会话，开始全新任务（pi 上下文一并重置）" onClick={newSession}>
					＋ 新任务
				</button>
			)}
			<input
				value={text}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					// IME composition Enter (committing pinyin candidates, Safari
					// reports it as key="Enter") must not submit the prompt.
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter") submit();
				}}
			/>
			{orchBusy && bolt ? (
				<button className="pg-btn pg-btn-danger" onClick={abortRun}>
					⏹ 中止编排
				</button>
			) : bolt ? (
				<button className="pg-btn" disabled={!text.trim() || orchBusy} onClick={submit}>
					⚡ 编排
				</button>
			) : running ? (
				<button className="pg-btn pg-btn-danger" onClick={abort}>
					abort
				</button>
			) : (
				<button
					className="pg-btn"
					disabled={!text.trim()}
					onClick={() => {
						sendPrompt(text.trim());
						setText("");
					}}
				>
					send
				</button>
			)}
		</footer>
	);
}

/** Mini live-trace graph (迷你实时图) — bottom of the side column. */
function MiniGraph() {
	return (
		<div className="pg-mini">
			<div className="pg-mini-header">实时图</div>
			<div className="pg-mini-canvas">
				<GraphCanvas key="live" compact />
			</div>
		</div>
	);
}

/**
 * 实时 tab: chat is the PRIMARY surface in the main pane (history replay puts
 * the frozen graph there instead); the side column holds node details (on
 * demand) over the mini graph. The main/side split and the detail/mini split
 * are both drag-resizable, with layouts remembered across reloads.
 */
function LivePage({ setTab }: { setTab: (t: Tab) => void }) {
	const history = useStore((s) => s.history);
	const selectedNodeId = useStore((s) => s.selectedNodeId);
	const select = useStore((s) => s.select);
	// panelIds: "side" conditionally unmounts (history replay, no selection) —
	// without this the resulting 1-panel commit would overwrite the saved
	// main+side split; with it, layouts persist per panel-set under separate keys
	const mainLayout = useDefaultLayout({ id: "pg-live-main", panelIds: ["main", "side"], storage: localStorage });
	const sideLayout = useDefaultLayout({ id: "pg-live-side", storage: localStorage });
	return (
		<>
			<div className="pg-main">
				<Group orientation="horizontal" className="pg-pgroup" {...mainLayout}>
					<Panel id="main" className="pg-fill" defaultSize="62" minSize={360}>
						{history ? (
							<div className="pg-canvas">
								<GraphCanvas key="history" graphOverride={history.graph} />
							</div>
						) : (
							<ChatPanel onOpenOrch={() => setTab("orch")} />
						)}
					</Panel>
					{/* Side column: the mini graph fills it by default; node details
					    mount ON DEMAND above the graph while a node is selected (再点
					    节点或 × 关闭). History replay has no mini graph, so the column
					    only exists while a node is selected — the frozen graph gets the
					    full width otherwise. */}
					{(!history || selectedNodeId) && (
						<>
							<Separator className="pg-rh pg-rh-col" />
							<Panel id="side" className="pg-fill pg-side" defaultSize="38" minSize={280}>
								{selectedNodeId && !history ? (
									<Group orientation="vertical" className="pg-pgroup" {...sideLayout}>
										<Panel id="detail" className="pg-fill" defaultSize="55" minSize={120}>
											<DetailPanel onClose={() => select(null)} />
										</Panel>
										<Separator className="pg-rh pg-rh-row" />
										<Panel id="mini" className="pg-fill" defaultSize="45" minSize={160}>
											<MiniGraph />
										</Panel>
									</Group>
								) : selectedNodeId ? (
									<DetailPanel onClose={() => select(null)} />
								) : (
									<MiniGraph />
								)}
							</Panel>
						</>
					)}
				</Group>
			</div>
			<PromptBar />
		</>
	);
}

export default function App() {
	useEffect(() => {
		connect();
	}, []);
	const [tab, setTab] = useState<Tab>("live");
	return (
		<div className="pg-app">
			<Header tab={tab} setTab={setTab} />
			{tab === "orch" ? <OrchestratePage /> : <LivePage setTab={setTab} />}
			<HistoryDrawer />
		</div>
	);
}

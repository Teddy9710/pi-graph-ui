/**
 * App shell: header (tabs + connection + usage) and three tabs — 实时 (chat-first
 * live page: a persistent session sidebar on the left, conversation as the
 * main area, a mini live-trace graph in the side column; node details appear
 * on demand above it while a node is selected), 编排 (graph orchestration
 * editor) and 模型 (provider/key/default-model configuration for pi's
 * models.json + repo .env). Every pane boundary is user-resizable
 * (react-resizable-panels, layout remembered in localStorage).
 */

import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { ChatPanel } from "./ChatPanel.tsx";
import { DetailPanel } from "./DetailPanel.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { ModelsPage } from "./ModelsPage.tsx";
import { OrchestratePage } from "./OrchestratePage.tsx";
import { SessionRail, SessionSidebar } from "./SessionSidebar.tsx";
import { useOrchStore } from "./orch-store.ts";
import { connect, useStore } from "./store.ts";
import "./app.css";

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

type Tab = "live" | "orch" | "models";

function Header({
	tab,
	setTab,
	sessionsCollapsed,
	toggleSessions,
}: {
	tab: Tab;
	setTab: (t: Tab) => void;
	sessionsCollapsed: boolean;
	toggleSessions: () => void;
}) {
	const wsStatus = useStore((s) => s.wsStatus);
	const session = useStore((s) => s.session);
	const piExit = useStore((s) => s.piExit);
	const history = useStore((s) => s.history);
	const exitHistory = useStore((s) => s.exitHistory);
	const statusText =
		wsStatus === "open"
			? "● 已连接"
			: wsStatus === "reconnecting"
				? "● 重连中…"
				: wsStatus === "connecting"
					? "● 连接中…"
					: "● 已断开";
	return (
		<header className="pg-header">
			<b className="pg-logo">pi-graph</b>
			<button
				className={`pg-tab${tab === "live" ? " active" : ""}`}
				aria-current={tab === "live" ? "page" : undefined}
				onClick={() => setTab("live")}
			>
				实时
			</button>
			<button
				className={`pg-tab${tab === "orch" ? " active" : ""}`}
				aria-current={tab === "orch" ? "page" : undefined}
				onClick={() => setTab("orch")}
			>
				编排
			</button>
			<button
				className={`pg-tab${tab === "models" ? " active" : ""}`}
				aria-current={tab === "models" ? "page" : undefined}
				onClick={() => setTab("models")}
				title="模型 provider / 密钥 / 默认模型配置（models.json + .env）"
			>
				模型
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
						{session.agentStatus === "running" ? "agent 运行中…" : "agent 空闲"}
					</span>
					<span className="pg-dim pg-usage">
						↑{formatTokens(session.usageTotal.input)} ↓{formatTokens(session.usageTotal.output)} tok
					</span>
				</>
			)}
			{session.lastError && !history && (
				<span className="pg-error-text" title={session.lastError}>
					{session.lastError.slice(0, 80)}
				</span>
			)}
			{piExit && (
				<span className="pg-error-text" title={piExit.stderr.slice(-500)}>
					pi exited (code {piExit.code ?? "?"}) — 检查 bridge server
				</span>
			)}
			<button
				className="pg-btn pg-btn-ghost pg-btn-sm pg-history-btn"
				aria-expanded={!sessionsCollapsed}
				title={sessionsCollapsed ? "展开左侧会话栏" : "折叠左侧会话栏"}
				onClick={toggleSessions}
			>
				☰ 会话
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
	const wsStatus = useStore((s) => s.wsStatus);
	const sendPrompt = useStore((s) => s.sendPrompt);
	const steer = useStore((s) => s.steer);
	const abort = useStore((s) => s.abort);
	const history = useStore((s) => s.history);
	const run = useOrchStore((s) => s.run);
	const planRun = useOrchStore((s) => s.planRun);
	const abortRun = useOrchStore((s) => s.abortRun);
	const running = session.agentStatus === "running";
	const orchBusy = run.status === "running" || run.status === "planning";
	const offline = wsStatus !== "open";

	if (history) {
		return (
			<footer className="pg-input-bar">
				<input disabled placeholder="正在查看历史会话（对话与图均为存档），返回实时后可继续对话" />
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
		// send() silently drops payloads on a non-OPEN socket — bailing here
		// (WITHOUT clearing the input) means no message vanishes without a
		// trace while disconnected; the offline notice says why.
		if (offline) return;
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
				aria-label="自动编排模式"
				title={bolt ? "⚡ 开启中：发送的内容将作为编排目标" : "开启 ⚡ 自动编排：发送目标 → 自动拆图执行 → 结果整理回对话"}
				onClick={() => setBolt((v) => !v)}
			>
				⚡
			</button>
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
				<button className="pg-btn" disabled={!text.trim() || orchBusy || offline} onClick={submit}>
					⚡ 编排
				</button>
			) : running ? (
				<>
					{text.trim() && (
						<button className="pg-btn" title="把输入作为转向指令插入当前运行" onClick={submit}>
							↪ 转向
						</button>
					)}
					<button className="pg-btn pg-btn-danger" onClick={abort}>
						⏹ 中止
					</button>
				</>
			) : (
				<button className="pg-btn" disabled={!text.trim() || offline} onClick={submit}>
					发送
				</button>
			)}
			{offline && <span className="pg-error-text">未连接 — 消息不会发出，请等待重连</span>}
		</footer>
	);
}

/** Mini live-trace graph (迷你实时图) — side column. History browsing swaps
 *  the source: the frozen archive graph (selectable, details still work). */
function MiniGraph() {
	const history = useStore((s) => s.history);
	return (
		<div className="pg-mini">
			<div className="pg-mini-header">{history ? "历史图" : "实时图"}</div>
			<div className="pg-mini-canvas">
				{history ? (
					<GraphCanvas key="history" compact graphOverride={history.graph} />
				) : (
					<GraphCanvas key="live" compact />
				)}
			</div>
		</div>
	);
}

/**
 * 实时 tab: the persistent session sidebar owns the left column (collapse it
 * to a 40px rail from the sidebar-header « or the header ☰ 会话 button;
 * expand from the rail's » button). Chat is the PRIMARY surface
 * in the main pane — in history browsing too, where the column shows the
 * archived transcript and the side graph shows the frozen archive. The side
 * column holds node details (on demand) over the graph. Every split —
 * sessions|content, chat|side, detail|graph — is drag-resizable with layouts
 * remembered across reloads.
 */
function LivePage({
	setTab,
	sessionsCollapsed,
	setSessionsCollapsed,
}: {
	setTab: (t: Tab) => void;
	sessionsCollapsed: boolean;
	setSessionsCollapsed: (v: boolean) => void;
}) {
	const history = useStore((s) => s.history);
	const selectedNodeId = useStore((s) => s.selectedNodeId);
	const select = useStore((s) => s.select);
	const newSession = useStore((s) => s.newSession);
	const rootLayout = useDefaultLayout({ id: "pg-live-root", panelIds: ["sessions", "content"], storage: localStorage });
	const mainLayout = useDefaultLayout({ id: "pg-live-main", panelIds: ["main", "side"], storage: localStorage });
	const sideLayout = useDefaultLayout({ id: "pg-live-side", storage: localStorage });
	return (
		<>
			<div className="pg-main">
				{sessionsCollapsed && (
					<SessionRail onExpand={() => setSessionsCollapsed(false)} onNewSession={newSession} />
				)}
				<Group orientation="horizontal" className="pg-pgroup" {...rootLayout}>
					{!sessionsCollapsed && (
						<>
							{/* The atlas ledger: every archived conversation, current
							    pinned top; ＋新对话 resets pi's context without losing
							    the old thread (it stays listed & resumable). */}
							<Panel id="sessions" className="pg-fill" defaultSize="20" minSize={13}>
								<SessionSidebar onNewSession={newSession} onCollapse={() => setSessionsCollapsed(true)} />
							</Panel>
							<Separator
								className="pg-rh pg-rh-col"
								title="拖拽调整 · 双击复位"
								aria-label="拖动调整会话栏与对话区的宽度"
							/>
						</>
					)}
					<Panel id="content" className="pg-fill" defaultSize="80" minSize={400}>
						<Group orientation="horizontal" className="pg-pgroup" {...mainLayout}>
							<Panel id="main" className="pg-fill" defaultSize="62" minSize={360}>
								<ChatPanel onOpenOrch={() => setTab("orch")} />
							</Panel>
							{/* Side column: the trace graph fills it by default (live or
							    the frozen archive); node details mount ON DEMAND above it
							    while a node is selected (再点节点或 × 关闭) — the selection
							    works on the archived graph too, so history browsing keeps
							    node inspection. */}
							<Separator
								className="pg-rh pg-rh-col"
								title="拖拽调整 · 双击复位"
								aria-label="拖动调整对话与侧栏的宽度"
							/>
							<Panel id="side" className="pg-fill pg-side" defaultSize="38" minSize={280}>
								{selectedNodeId ? (
									<Group orientation="vertical" className="pg-pgroup" {...sideLayout}>
										<Panel id="detail" className="pg-fill" defaultSize="55" minSize={120}>
											<DetailPanel onClose={() => select(null)} />
										</Panel>
										<Separator
											className="pg-rh pg-rh-row"
											title="拖拽调整 · 双击复位"
											aria-label="拖动调整节点详情与实时图的高度"
										/>
										<Panel id="mini" className="pg-fill" defaultSize="45" minSize={160}>
											<MiniGraph />
										</Panel>
									</Group>
								) : (
									<MiniGraph />
								)}
							</Panel>
						</Group>
					</Panel>
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
	// Sidebar collapse persists across reloads (the layout panels already
	// remember their sizes; this covers the fully-collapsed state).
	const [sessionsCollapsed, setSessionsCollapsed] = useState(
		() => localStorage.getItem("pi-graph.sessions.collapsed") === "1",
	);
	useEffect(() => {
		localStorage.setItem("pi-graph.sessions.collapsed", sessionsCollapsed ? "1" : "0");
	}, [sessionsCollapsed]);
	return (
		<div className="pg-app">
			<Header
				tab={tab}
				setTab={setTab}
				sessionsCollapsed={sessionsCollapsed}
				toggleSessions={() => setSessionsCollapsed((v) => !v)}
			/>
			{tab === "orch" ? (
				<OrchestratePage />
			) : tab === "models" ? (
				<ModelsPage />
			) : (
				<LivePage setTab={setTab} sessionsCollapsed={sessionsCollapsed} setSessionsCollapsed={setSessionsCollapsed} />
			)}
		</div>
	);
}

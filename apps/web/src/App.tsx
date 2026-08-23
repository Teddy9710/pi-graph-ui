/**
 * App shell: header (tabs + connection + usage) and two tabs — 实时 (live
 * trace: graph canvas, detail panel, prompt input) and 编排 (graph
 * orchestration editor). HistoryDrawer stays mounted at app level.
 */

import { useEffect, useState } from "react";
import { DetailPanel } from "./DetailPanel.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { HistoryDrawer } from "./HistoryDrawer.tsx";
import { OrchestratePage } from "./OrchestratePage.tsx";
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
			<b>pi-graph</b>
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
					<span className="pg-dim">
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

function PromptBar() {
	const [text, setText] = useState("");
	const session = useStore((s) => s.session);
	const sendPrompt = useStore((s) => s.sendPrompt);
	const steer = useStore((s) => s.steer);
	const abort = useStore((s) => s.abort);
	const newSession = useStore((s) => s.newSession);
	const history = useStore((s) => s.history);
	const running = session.agentStatus === "running";

	if (history) {
		return (
			<footer className="pg-input-bar">
				<input disabled placeholder="正在查看历史回放，返回实时后可继续对话" />
			</footer>
		);
	}

	return (
		<footer className="pg-input-bar">
			{!running && (
				<button className="pg-btn pg-btn-ghost" title="清空当前会话，开始全新任务（pi 上下文一并重置）" onClick={newSession}>
					＋ 新任务
				</button>
			)}
			<input
				value={text}
				placeholder={running ? "运行中… 输入内容可插入转向指令 (steer)" : "给 pi agent 发一个任务…"}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					// IME composition Enter (committing pinyin candidates, Safari
					// reports it as key="Enter") must not submit the prompt.
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter" && text.trim()) {
						if (running) steer(text.trim());
						else sendPrompt(text.trim());
						setText("");
					}
				}}
			/>
			{running ? (
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

export default function App() {
	useEffect(() => {
		connect();
	}, []);
	const history = useStore((s) => s.history);
	const [tab, setTab] = useState<Tab>("live");
	return (
		<div className="pg-app">
			<Header tab={tab} setTab={setTab} />
			{tab === "orch" ? (
				<OrchestratePage />
			) : (
				<>
					<div className="pg-main">
						<div className="pg-canvas">
							{/* History view replays a frozen graph; live view keeps streaming. */}
							{history ? <GraphCanvas key="history" graphOverride={history.graph} /> : <GraphCanvas key="live" />}
						</div>
						<DetailPanel />
					</div>
					<PromptBar />
				</>
			)}
			<HistoryDrawer />
		</div>
	);
}

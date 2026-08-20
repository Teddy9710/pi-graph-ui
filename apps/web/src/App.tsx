/**
 * App shell: header (connection + usage), graph canvas, detail panel,
 * prompt input with abort/steer.
 */

import { useEffect, useState } from "react";
import { DetailPanel } from "./DetailPanel.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { connect, useStore } from "./store.ts";
import "./app.css";

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function Header() {
	const wsStatus = useStore((s) => s.wsStatus);
	const session = useStore((s) => s.session);
	const piExit = useStore((s) => s.piExit);
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
			<span className={`pg-ws pg-ws-${wsStatus}`}>{statusText}</span>
			<span className="pg-dim">
				{session.agentStatus === "running" ? "agent running…" : "agent idle"}
			</span>
			<span className="pg-dim">
				↑{formatTokens(session.usageTotal.input)} ↓{formatTokens(session.usageTotal.output)} tok
			</span>
			{session.lastError && <span className="pg-error-text">{session.lastError.slice(0, 80)}</span>}
			{piExit && (
				<span className="pg-error-text" title={piExit.stderr.slice(-500)}>
					pi exited (code {piExit.code ?? "?"}) — 检查 bridge server
				</span>
			)}
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
	const running = session.agentStatus === "running";

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
	return (
		<div className="pg-app">
			<Header />
			<div className="pg-main">
				<div className="pg-canvas">
					<GraphCanvas />
				</div>
				<DetailPanel />
			</div>
			<PromptBar />
		</div>
	);
}

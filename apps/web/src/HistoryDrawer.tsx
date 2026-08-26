/**
 * History drawer: list of archived sessions (from the bridge's SessionStore),
 * click to replay one onto the canvas as a read-only graph.
 */

import { useStore } from "./store.ts";

function formatTime(ms: number): string {
	if (!ms) return "";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function HistoryDrawer() {
	const open = useStore((s) => s.historyOpen);
	const sessions = useStore((s) => s.sessions);
	const sessionsError = useStore((s) => s.sessionsError);
	const loadHistory = useStore((s) => s.loadHistory);
	const history = useStore((s) => s.history);

	if (!open) return null;

	return (
		<div className="pg-drawer-overlay" onClick={() => useStore.setState({ historyOpen: false })}>
			<aside className="pg-drawer" onClick={(e) => e.stopPropagation()}>
				<header>
					<b>历史会话</b>
					<button className="pg-drawer-close" onClick={() => useStore.setState({ historyOpen: false })}>
						×
					</button>
				</header>
				{sessions.length === 0 &&
					(sessionsError ? (
						<p className="pg-error-text">历史加载失败 — 检查 bridge server 是否在运行，关掉抽屉重开可重试</p>
					) : (
						<p className="pg-dim">暂无存档（发过任务后这里会出现）</p>
					))}
				<ul>
					{sessions.map((s) => (
						<li key={s.id}>
							<button
								className={`pg-session-item${history?.meta.id === s.id ? " active" : ""}`}
								onClick={() => void loadHistory(s.id)}
							>
								<div className="pg-session-title">{s.firstUserText ?? "(无文本输入)"}</div>
								<div className="pg-dim">
									{formatTime(s.startedAt)} · {s.eventCount} events · ↓{s.outputTokens} tok
								</div>
							</button>
						</li>
					))}
				</ul>
			</aside>
		</div>
	);
}

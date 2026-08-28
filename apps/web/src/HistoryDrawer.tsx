/**
 * History drawer: list of archived sessions (from the bridge's SessionStore),
 * click to replay one onto the canvas as a read-only graph. It is a modal
 * layer: Esc and the overlay close it, focus lands in the drawer on open.
 */

import { useEffect, useRef } from "react";
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
	const sessionsLoading = useStore((s) => s.sessionsLoading);
	const historyError = useStore((s) => s.historyError);
	const loadHistory = useStore((s) => s.loadHistory);
	const history = useStore((s) => s.history);

	const drawerRef = useRef<HTMLElement | null>(null);

	// Modal behavior: Esc closes, focus moves into the drawer (and stays
	// reachable — no full focus trap, the list itself is keyboard navigable).
	useEffect(() => {
		if (!open) return;
		drawerRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") useStore.setState({ historyOpen: false });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (!open) return null;

	return (
		<div className="pg-drawer-overlay" onClick={() => useStore.setState({ historyOpen: false })}>
			<aside
				className="pg-drawer"
				role="dialog"
				aria-modal="true"
				aria-label="历史会话"
				tabIndex={-1}
				ref={drawerRef}
				onClick={(e) => e.stopPropagation()}
			>
				<header>
					<b>历史会话</b>
					<button
						className="pg-drawer-close"
						aria-label="关闭历史会话"
						onClick={() => useStore.setState({ historyOpen: false })}
					>
						×
					</button>
				</header>
				{sessionsLoading && <p className="pg-dim">加载中…</p>}
				{!sessionsLoading && sessions.length === 0 &&
					(sessionsError ? (
						<p className="pg-error-text">历史加载失败 — 检查 bridge server 是否在运行，关掉抽屉重开可重试</p>
					) : (
						<p className="pg-dim">暂无存档（发过任务后这里会出现）</p>
					))}
				{historyError && (
					<p className="pg-error-text">
						{historyError.message} — 该会话回放失败
						<button
							className="pg-btn pg-btn-ghost pg-btn-sm"
							style={{ marginLeft: 8 }}
							onClick={() => void loadHistory(historyError.id)}
						>
							重试
						</button>
					</p>
				)}
				<ul>
					{sessions.map((s) => (
						<li key={s.id}>
							<button
								className={`pg-session-item${history?.meta.id === s.id ? " active" : ""}`}
								disabled={history?.loading === true}
								aria-busy={history?.loading === true}
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

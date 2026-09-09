/**
 * SessionSidebar — the atlas ledger (常驻会话栏): every archived conversation
 * pinned to the left of the live page. One row = one archive:
 *   resumable  → main click RESUMES it as the live session (server-side RPC
 *                switch_session — pi's context really comes back, replies
 *                continue the old thread)
 *   !resumable → main click replays it read-only (loadHistory, badge 仅回放)
 *   current    → magenta spine + 「当前」mark; main click is a no-op, delete is
 *                refused server-side (409) and disabled here
 * The live-but-unarchived session (fresh, no message yet) renders as a
 * placeholder row on top. ＋新对话 resets pi's context and starts a fresh
 * archive — nothing is lost, the previous conversation stays in this list.
 *
 * Collapsed mode is a fixed 40px rail (SessionRail): expand + ＋新对话.
 */

import { useEffect, useState } from "react";
import { useOrchStore } from "./orch-store.ts";
import { useStore, type SessionMeta } from "./store.ts";

function formatTime(ms: number): string {
	if (!ms) return "";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SessionRail({ onExpand, onNewSession }: { onExpand: () => void; onNewSession: () => void }) {
	return (
		<aside className="pg-sessions-rail" aria-label="会话栏（已折叠）">
			<button className="pg-session-act" title="展开会话栏" aria-label="展开会话栏" onClick={onExpand}>
				»
			</button>
			<button className="pg-session-act" title="新对话" aria-label="新对话" onClick={onNewSession}>
				＋
			</button>
		</aside>
	);
}

export function SessionSidebar({ onNewSession }: { onNewSession: () => void }) {
	const sessions = useStore((s) => s.sessions);
	const sessionsError = useStore((s) => s.sessionsError);
	const sessionsLoading = useStore((s) => s.sessionsLoading);
	const historyError = useStore((s) => s.historyError);
	const history = useStore((s) => s.history);
	const loadHistory = useStore((s) => s.loadHistory);
	const exitHistory = useStore((s) => s.exitHistory);
	const sessionId = useStore((s) => s.sessionId);
	const switching = useStore((s) => s.switching);
	const sessionActionError = useStore((s) => s.sessionActionError);
	const session = useStore((s) => s.session);
	const wsStatus = useStore((s) => s.wsStatus);
	const switchSession = useStore((s) => s.switchSession);
	const deleteSession = useStore((s) => s.deleteSession);
	const renameSession = useStore((s) => s.renameSession);
	const refreshSessions = useStore((s) => s.refreshSessions);
	const run = useOrchStore((s) => s.run);

	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	// The list loads on mount; later refreshes ride the hello/session_bound
	// nudges from the store (debounced there).
	useEffect(() => {
		void refreshSessions();
	}, [refreshSessions]);

	const agentBusy = session.agentStatus === "running";
	const runBusy = run.status === "running" || run.status === "planning";
	// Why a RESUME would be refused right now (title on disabled rows). Empty
	// string = not busy — replay/delete/rename never care about these.
	const busyReason = switching
		? "会话切换进行中，请稍候"
		: agentBusy
			? "agent 运行中，等待其停止或先中止后再切换"
			: runBusy
				? "编排运行中，先中止编排再切换"
				: wsStatus !== "open"
					? "未连接"
					: "";

	const current = sessions.find((s) => s.id === sessionId) ?? null;
	const rows = current ? [current, ...sessions.filter((s) => s.id !== sessionId)] : sessions;
	// sessionId===null while messages exist means PI_NO_SESSION mode (or a
	// sub-frame race) — the placeholder would lie; only show it truly fresh.
	const showPlaceholder = sessionId === null && session.messages.length === 0;

	const startRename = (s: SessionMeta) => {
		setEditingId(s.id);
		setDraft(s.title ?? s.firstUserText ?? "");
	};
	const commitRename = () => {
		const id = editingId;
		const title = draft.trim();
		setEditingId(null);
		// Empty/whitespace = cancel, mirroring the server's trim-based validity.
		if (id && title) void renameSession(id, title);
	};
	const mainClick = (s: SessionMeta) => {
		if (s.id === sessionId) return;
		if (s.resumable) {
			// A read-only replay of ANOTHER archive must not survive a live
			// switch — the hello rebuilds the LIVE view; drop browsing first.
			if (history) exitHistory();
			switchSession(s.id);
		} else {
			void loadHistory(s.id);
		}
	};
	const removeClick = (s: SessionMeta) => {
		const label = s.title ?? s.firstUserText ?? s.id;
		if (window.confirm(`删除会话「${label}」？归档与 pi 会话文件将被移除，不可恢复`)) void deleteSession(s.id);
	};

	return (
		<aside className="pg-sessions" aria-label="会话列表">
			<header className="pg-sessions-head">
				<b>会话</b>
				{switching && <span className="pg-dim">切换中…</span>}
				<button
					className="pg-btn pg-btn-ghost pg-btn-sm"
					disabled={switching}
					title="开启全新对话（当前对话保留在此列表，可随时恢复）"
					onClick={() => {
						if (history) exitHistory();
						onNewSession();
					}}
				>
					＋ 新对话
				</button>
			</header>
			{sessionActionError && (
				<p className="pg-error-text pg-sessions-error" title={sessionActionError}>
					{sessionActionError}
				</p>
			)}
			{historyError && (
				<p className="pg-error-text pg-sessions-error">
					{historyError.message} — 回放失败
					<button
						className="pg-btn pg-btn-ghost pg-btn-sm"
						style={{ marginLeft: 6 }}
						onClick={() => void loadHistory(historyError.id)}
					>
						重试
					</button>
				</p>
			)}
			<ul className="pg-sessions-list">
				{showPlaceholder && (
					<li>
						<button className="pg-session-item active" disabled>
							<div className="pg-session-title">
								<span className="pg-session-mark">当前</span>(新会话，尚未发送消息)
							</div>
						</button>
					</li>
				)}
				{rows.map((s) => {
					const isCurrent = s.id === sessionId;
					const editing = editingId === s.id;
					// Main click: resume is guarded (busy/offline/current);
					// read-only replay is always allowed, only not mid-load.
					const mainDisabled = isCurrent || (s.resumable ? busyReason !== "" : history?.loading === true);
					return (
						<li key={s.id}>
							{editing ? (
								<input
									className="pg-form-input pg-session-rename"
									autoFocus
									value={draft}
									maxLength={120}
									placeholder="会话标题"
									aria-label="会话标题"
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={(e) => {
										// IME composition Enter must not commit.
										if (e.nativeEvent.isComposing) return;
										if (e.key === "Enter") commitRename();
										else if (e.key === "Escape") setEditingId(null);
									}}
									onBlur={() => commitRename()}
								/>
							) : (
								<button
									className={`pg-session-item${isCurrent ? " active" : ""}`}
									// Not the native `disabled`: disabled buttons don't
									// propagate :hover in Chromium, which would keep the
									// row's action cluster (✎/✕) permanently invisible
									// on the current row. mainClick guards anyway.
									aria-disabled={mainDisabled || undefined}
									aria-current={isCurrent ? "true" : undefined}
									title={
										s.resumable
											? isCurrent
												? "当前会话"
												: busyReason || "恢复此会话为当前对话（pi 上下文一并恢复）"
											: "此存档没有 pi 会话文件，只读回放"
									}
									onClick={() => mainClick(s)}
								>
									<div className="pg-session-title">
										{isCurrent && <span className="pg-session-mark">当前</span>}
										{s.title ?? s.firstUserText ?? "(无文本输入)"}
									</div>
									<div className="pg-dim">
										{formatTime(s.startedAt)} · {s.eventCount} events · ↓{s.outputTokens} tok
										{!s.resumable && <span className="pg-session-badge">仅回放</span>}
									</div>
								</button>
							)}
							{!editing && (
								<span className="pg-session-actions">
									{s.resumable && !isCurrent && (
										<button
											className="pg-session-act"
											title="只读回放（不改变当前对话）"
											aria-label={`只读回放会话 ${s.id}`}
											onClick={() => void loadHistory(s.id)}
										>
											▶
										</button>
									)}
									<button
										className="pg-session-act"
										title="重命名"
										aria-label={`重命名会话 ${s.id}`}
										onClick={() => startRename(s)}
									>
										✎
									</button>
									<button
										className="pg-session-act"
										title={isCurrent ? "当前活跃会话不能删除（先切换或新建）" : "删除会话"}
										aria-label={`删除会话 ${s.id}`}
										disabled={isCurrent}
										onClick={() => removeClick(s)}
									>
										✕
									</button>
								</span>
							)}
						</li>
					);
				})}
				{sessionsLoading && sessions.length === 0 && (
					<li className="pg-dim pg-sessions-note">加载中…</li>
				)}
				{!sessionsLoading && sessions.length === 0 && !showPlaceholder && (
					<li className="pg-dim pg-sessions-note">
						{sessionsError ? "会话列表加载失败 — 检查 bridge server 是否在运行" : "暂无存档（发过任务后这里会出现）"}
					</li>
				)}
			</ul>
		</aside>
	);
}

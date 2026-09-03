/**
 * MAIN chat column of the live page (对话为主布局): the session transcript as
 * a chat flow — user bubbles, assistant replies (text only; tool calls as a
 * count), and the orchestration exchange (goal card with live status +
 * collapsed results-injection details, both carrying a 「查看编排」 jump to
 * the orchestration tab). The timeline merge itself lives in shared
 * (buildChatTimeline) so it stays unit-tested; this file only renders.
 *
 * The orch card reads the folded RunState directly (status/counts/plan tail);
 * the item from buildChatTimeline is just the ordering anchor. Only the
 * LATEST planned run gets a card — older exchanges keep their injected
 * details + assistant answers in the transcript (v1, see PLAN.md M-C).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { buildChatTimeline, initRunState, type ChatItem } from "@pi-graph/shared";
import { RUN_STATUS_LABEL, runStatusChatClass } from "./status.ts";
import { useOrchStore } from "./orch-store.ts";
import { useStore } from "./store.ts";

function Bubble({ item }: { item: Extract<ChatItem, { kind: "user" | "assistant" }> }) {
	if (item.kind === "user") {
		return <div className="pg-chat-row"><div className="pg-chat-bubble pg-chat-bubble-user">{item.text}</div></div>;
	}
	return (
		<div className="pg-chat-row pg-chat-row-assistant" aria-busy={item.streaming}>
			<div className="pg-chat-bubble">
				{item.text || (item.streaming ? "" : <span className="pg-dim">（无文本回复）</span>)}
				{item.streaming && <span className="pg-chat-cursor" aria-hidden />}
			</div>
			{item.toolCalls > 0 && <div className="pg-chat-tools">🔧 {item.toolCalls} 个工具调用</div>}
		</div>
	);
}

function InjectedCard({ item, onOpenOrch }: { item: Extract<ChatItem, { kind: "injected" }>; onOpenOrch: () => void }) {
	const count = item.meta?.nodeCount ?? "?";
	const goal = item.meta?.goal;
	// The injected payload can reach ~120KB. A closed <details> skips layout,
	// but React still diffs the whole text node on every timeline rebuild —
	// mount the <pre> only once opened and the diff becomes trivial.
	const [open, setOpen] = useState(false);
	return (
		<div className="pg-chat-injected">
			<details onToggle={(e) => setOpen(e.currentTarget.open)}>
				<summary>
					⚙ 编排结果已注入会话（{count} 节点）{goal ? ` — ${goal.slice(0, 30)}${goal.length > 30 ? "…" : ""}` : ""}
				</summary>
				{open && <pre className="pg-pre">{item.raw}</pre>}
			</details>
			<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={onOpenOrch}>
				查看编排 →
			</button>
		</div>
	);
}

function OrchCard({ onOpenOrch }: { onOpenOrch: () => void }) {
	const run = useOrchStore((s) => s.run);
	const statusText = RUN_STATUS_LABEL[run.status] ?? run.status;
	const statusClass = runStatusChatClass(run.status);
	const total = run.graph?.nodes.length ?? Object.keys(run.nodes).length;
	const planTail =
		run.status === "planning" && run.planText ? run.planText.slice(-120) : null;
	return (
		<div className="pg-chat-row pg-chat-row-assistant">
			<div className="pg-chat-bubble pg-chat-bubble-user">{run.goal ?? ""}</div>
			<div className="pg-chat-orch-card">
				<div className={statusClass} aria-live="polite">⚡ {statusText}</div>
				{run.status !== "planning" && total > 0 && (
					<div className="pg-chat-chips">
						<span className="pg-orch-chip">✓ {run.ok} / {total}</span>
						{run.failed > 0 && <span className="pg-orch-chip">✗ {run.failed}</span>}
						{run.skipped > 0 && <span className="pg-orch-chip">⏭ {run.skipped}</span>}
					</div>
				)}
				{planTail && <pre className="pg-pre">{planTail}</pre>}
				<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={onOpenOrch}>
					查看编排 →
				</button>
			</div>
		</div>
	);
}

/** The chat-page surface for a suspended gate: the run parked on a human
 *  decision, so the DECISION comes to the conversation — review material,
 *  note, 批准/驳回 — without a detour to the orchestration tab. Rendered for
 *  ANY awaiting gate of the live run (chat-initiated or not): it is live
 *  state, not transcript history, so it rides after the timeline items and
 *  disappears the moment the decision settles (a refresh replays hello and
 *  re-materializes it, keeping a parked run approvable). */
function GateAwaitingCards() {
	const run = useOrchStore((s) => s.run);
	const approveNode = useOrchStore((s) => s.approveNode);
	const awaiting = Object.values(run.nodes).filter((n) => n.status === "awaiting");
	// node ids cannot contain commas (NODE_ID_RE) — safe join key
	const awaitingIds = awaiting.map((n) => n.id).join(",");
	// One note per decision, the same lifecycle discipline as the node panel:
	// a settled/dropped card loses its note; a still-awaiting sibling keeps
	// what the reviewer typed (a send in flight may need a retry).
	const [notes, setNotes] = useState<Record<string, string>>({});
	useEffect(() => {
		const ids = awaitingIds.split(",").filter(Boolean);
		setNotes((prev) => {
			if (ids.length === Object.keys(prev).length && ids.every((id) => prev[id] !== undefined)) return prev;
			const next: Record<string, string> = {};
			for (const id of ids) next[id] = prev[id] ?? "";
			return next;
		});
	}, [awaitingIds]);
	if (awaiting.length === 0) return null;
	return (
		<>
			{awaiting.map((n) => {
				const label = run.graph?.nodes.find((g) => g.id === n.id)?.label ?? n.id;
				return (
					<div key={`${run.runId}:${n.id}`} className="pg-chat-gate-card">
						{/* The polite region is the HEADER only: the review pre can
						    carry up to 50KB of upstream output per upstream — an
						    aria-live wrapper would read all of it on mount before
						    the buttons are even reachable (OrchCard keeps its live
						    region to one status line for the same reason). */}
						<div className="pg-chat-gate-head" role="status" aria-live="polite">
							<span className="pg-icon pg-orch-gate-mark">门</span>
							<b>{label}</b>
							<span className="pg-dim">等待人工审校</span>
						</div>
						<pre className="pg-pre" aria-hidden="true">{n.assembledPrompt ?? ""}</pre>
						<input
							className="pg-form-input"
							placeholder="备注（可选）：批准时注入下游，驳回时作为理由"
							maxLength={2000}
							value={notes[n.id] ?? ""}
							onChange={(e) => setNotes((prev) => ({ ...prev, [n.id]: e.target.value }))}
						/>
						<div className="pg-gate-actions">
							<button className="pg-btn" onClick={() => approveNode(n.id, true, notes[n.id] ?? "")}>
								批准
							</button>
							<button
								className="pg-btn pg-btn-danger"
								onClick={() => approveNode(n.id, false, notes[n.id] ?? "")}
							>
								驳回
							</button>
						</div>
					</div>
				);
			})}
		</>
	);
}

export function ChatPanel({ onOpenOrch }: { onOpenOrch: () => void }) {
	// Subscribe to the session OBJECT, not s.session.messages: ingest()
	// shallow-copies session per event but foldEvent pushes into the SAME
	// messages array, so the array reference never changes and an
	// array-selecting subscriber would miss message_end appends (a user
	// bubble would sit invisible until the next streaming tick).
	const session = useStore((s) => s.session);
	const run = useOrchStore((s) => s.run);
	// History browsing: the column shows the ARCHIVED transcript instead —
	// same pure timeline merge, but over the frozen fold and an idle run
	// (no ⚡ card: the archived session's run events live in a separate
	// archive; its injected messages still render as details cards).
	const history = useStore((s) => s.history);
	const browsing = history !== null;
	const source = browsing ? history.session : session;

	// The timeline only depends on the transcript + run identity/status;
	// memo so unrelated store ticks (tool updates) don't re-merge it.
	const items = useMemo(
		() =>
			buildChatTimeline(
				source.messages,
				browsing ? initRunState() : run,
				browsing ? null : source.streamingAssistant,
			),
		[source, run, browsing],
	);
	// A mounting gate card is NOT a timeline item — the follow effect needs
	// this flag or the approval prompt could appear below the fold. Never in
	// browsing mode: that card is LIVE state and must not leak into an
	// archived transcript (even if a run is parked on a gate right now).
	const gateLive =
		!browsing && Object.values(run.nodes).some((n) => n.status === "awaiting");

	// Follow the tail unless the user scrolled up (>40px from bottom). The
	// scroll write rides a rAF so bursts of streaming ticks pay one layout,
	// and stops entirely once the user has scrolled away; sending a message
	// re-arms following (you want to see what your prompt triggered).
	const listRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	// Mode switches move the viewport: an archive opens at the TOP (records
	// read from the beginning, no tail to follow); returning to live re-arms
	// following and jumps to the tail. Keyed on the ARCHIVE IDENTITY too —
	// browsing stays true through an A→B switch, and B must also open at the
	// top rather than inherit A's scroll offset.
	const historyId = browsing ? history.meta.id : null;
	useEffect(() => {
		const el = listRef.current;
		if (browsing) {
			followRef.current = false;
			if (el) el.scrollTop = 0;
			setAtBottom(el ? el.scrollHeight - el.scrollTop - el.clientHeight <= 40 : true);
			return;
		}
		followRef.current = true;
		setAtBottom(true);
		if (el) el.scrollTop = el.scrollHeight;
	}, [browsing, historyId]);
	useEffect(() => {
		if (browsing) return;
		const last = items[items.length - 1];
		if (last?.kind === "user") {
			followRef.current = true;
			setAtBottom(true);
		}
		if (!followRef.current) return;
		const id = requestAnimationFrame(() => {
			const el = listRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		});
		return () => cancelAnimationFrame(id);
	}, [items, gateLive, browsing]);

	const scrollToEnd = () => {
		followRef.current = true;
		setAtBottom(true);
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	};

	return (
		<aside className="pg-chat">
			<header className="pg-chat-header">
				{browsing ? (history.loading ? "历史对话（加载中…）" : "历史对话") : "对话"}
			</header>
			<div
				className="pg-chat-list"
				ref={listRef}
				role="log"
				aria-label="会话消息"
				onScroll={() => {
					const el = listRef.current;
					if (!el) return;
					const follow = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
					followRef.current = follow;
					setAtBottom(follow);
				}}
			>
				{browsing && history.loading && <div className="pg-chat-empty pg-dim">正在载入该会话的归档…</div>}
				{browsing && !history.loading && items.length === 0 && (
					<div className="pg-chat-empty pg-dim">该存档只有工具轨迹，没有对话消息（图在右侧「历史图」）。</div>
				)}
				{!browsing && items.length === 0 && !gateLive && (
					<div className="pg-chat-empty pg-dim">对话还没有开始——在下方输入框发第一条消息，或打开 ⚡ 直接用自动编排。</div>
				)}
				{items.map((item) =>
					item.kind === "orch" ? (
						<OrchCard key={item.id} onOpenOrch={onOpenOrch} />
					) : item.kind === "injected" ? (
						<InjectedCard key={item.id} item={item} onOpenOrch={onOpenOrch} />
					) : (
						<Bubble key={item.id} item={item} />
					),
				)}
				{!browsing && <GateAwaitingCards />}
			</div>
			{!atBottom && (
				<button className="pg-btn pg-btn-ghost pg-btn-sm pg-scroll-bottom" onClick={scrollToEnd}>
					↓ 回到最新
				</button>
			)}
		</aside>
	);
}

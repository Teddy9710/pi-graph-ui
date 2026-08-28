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
import { buildChatTimeline, type ChatItem } from "@pi-graph/shared";
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

export function ChatPanel({ onOpenOrch }: { onOpenOrch: () => void }) {
	// Subscribe to the session OBJECT, not s.session.messages: ingest()
	// shallow-copies session per event but foldEvent pushes into the SAME
	// messages array, so the array reference never changes and an
	// array-selecting subscriber would miss message_end appends (a user
	// bubble would sit invisible until the next streaming tick).
	const session = useStore((s) => s.session);
	const run = useOrchStore((s) => s.run);

	// The timeline only depends on the transcript + run identity/status;
	// memo so unrelated store ticks (tool updates) don't re-merge it.
	const items = useMemo(
		() => buildChatTimeline(session.messages, run, session.streamingAssistant),
		[session, run],
	);

	// Follow the tail unless the user scrolled up (>40px from bottom). The
	// scroll write rides a rAF so bursts of streaming ticks pay one layout,
	// and stops entirely once the user has scrolled away; sending a message
	// re-arms following (you want to see what your prompt triggered).
	const listRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	useEffect(() => {
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
	}, [items]);

	const scrollToEnd = () => {
		followRef.current = true;
		setAtBottom(true);
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	};

	return (
		<aside className="pg-chat">
			<header className="pg-chat-header">对话</header>
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
				{items.length === 0 && <div className="pg-chat-empty pg-dim">对话还没有开始——在下方输入框发第一条消息，或打开 ⚡ 直接用自动编排。</div>}
				{items.map((item) =>
					item.kind === "orch" ? (
						<OrchCard key={item.id} onOpenOrch={onOpenOrch} />
					) : item.kind === "injected" ? (
						<InjectedCard key={item.id} item={item} onOpenOrch={onOpenOrch} />
					) : (
						<Bubble key={item.id} item={item} />
					),
				)}
			</div>
			{!atBottom && (
				<button className="pg-btn pg-btn-ghost pg-btn-sm pg-scroll-bottom" onClick={scrollToEnd}>
					↓ 回到最新
				</button>
			)}
		</aside>
	);
}

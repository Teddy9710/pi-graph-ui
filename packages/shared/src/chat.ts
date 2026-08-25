/**
 * Chat timeline: merge the session transcript (user/assistant messages) with
 * the orchestration exchange (goal card + injected results) into ONE ordered
 * list for the live-page chat panel. Pure and total — the web layer only
 * renders what this produces, which keeps the merge logic unit-testable in
 * shared (apps/web has no test runner).
 *
 * Ordering contract: chronological by timestamp; same-millisecond ties break
 * by kind (user < orch card < injected results < assistant) so a user
 * utterance always precedes what it triggered and the injected results
 * precede the assistant reply consuming them. Array sort is stable, so equal
 * (timestamp, kind) items keep session order.
 */

import {
	ORCH_RESULTS_SENTINEL,
	parseOrchSynthMeta,
	type OrchSynthMeta,
	type RunState,
} from "./orchestration.ts";
import { getMessageId } from "./fold.ts";
import type { AssistantMessage, Message, UserMessage } from "./types.ts";

export type ChatItem =
	| { kind: "user"; id: string; timestamp: number; text: string }
	| {
			kind: "assistant";
			id: string;
			timestamp: number;
			text: string;
			toolCalls: number;
			hasThinking: boolean;
			streaming: boolean;
	  }
	/** The orchestration exchange card — the renderer reads the RunState
	 *  directly (status/counts/plan tail), so the item is just an anchor. */
	| { kind: "orch"; id: string; timestamp: number }
	| { kind: "injected"; id: string; timestamp: number; meta: OrchSynthMeta | null; raw: string };

const KIND_RANK: Record<ChatItem["kind"], number> = { user: 0, orch: 1, injected: 2, assistant: 3 };

/** Plain text of a user message (blocks joined; images become 「[图片]」). */
export function userText(m: UserMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content.map((b) => (b.type === "text" ? b.text : "[图片]")).join("\n");
}

/**
 * True for the sentinel-prefixed results-injection prompt (server-sent).
 * pi echoes prompts as message_end with BLOCK content ([{type:"text",…}]),
 * so the check must join text blocks rather than demand a plain string.
 */
export function isOrchInjected(m: Message): boolean {
	if (m.role !== "user") return false;
	if (typeof m.content === "string") return m.content.startsWith(ORCH_RESULTS_SENTINEL);
	return m.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.startsWith(ORCH_RESULTS_SENTINEL);
}

/** Full text of an injected prompt, string-or-blocks normalized. */
function injectedRaw(m: UserMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** Joined assistant text (thinking/toolCall blocks excluded — text only). */
function assistantText(m: AssistantMessage): string {
	return m.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/**
 * Build the chat timeline. `run` is the folded orchestration RunState (shared
 * singleton — only the LATEST planned run gets a card; older exchanges keep
 * their injected messages + assistant answers in the transcript). A run only
 * yields a card when it was PLANNED (goal ≠ null) and has started.
 */
export function buildChatTimeline(
	messages: readonly Message[],
	run: RunState,
	streamingAssistant: AssistantMessage | null,
): ChatItem[] {
	const items: ChatItem[] = [];
	if (run.status !== "idle" && run.goal !== null && run.startedAt !== null) {
		items.push({ kind: "orch", id: `orch:${run.runId ?? "current"}`, timestamp: run.startedAt });
	}
	messages.forEach((m, index) => {
		if (m.role === "user") {
			if (isOrchInjected(m)) {
				// The injected prompt can be ~120KB — never bubble it; the
				// renderer shows a collapsed card from the parsed meta.
				const content = injectedRaw(m);
				items.push({
					kind: "injected",
					id: `inj:${index}:${getMessageId(m)}`,
					timestamp: m.timestamp,
					meta: parseOrchSynthMeta(content),
					raw: content,
				});
			} else {
				items.push({ kind: "user", id: getMessageId(m), timestamp: m.timestamp, text: userText(m) });
			}
		} else if (m.role === "assistant") {
			items.push({
				kind: "assistant",
				id: getMessageId(m),
				timestamp: m.timestamp,
				text: assistantText(m),
				toolCalls: m.content.filter((b) => b.type === "toolCall").length,
				hasThinking: m.content.some((b) => b.type === "thinking"),
				streaming: false,
			});
		}
		// toolResult messages are skipped in v1 — the graph canvas owns them.
	});
	if (streamingAssistant) {
		// The streaming draft is by definition the newest assistant message.
		items.push({
			kind: "assistant",
			id: `stream:${getMessageId(streamingAssistant)}`,
			timestamp: streamingAssistant.timestamp,
			text: assistantText(streamingAssistant),
			toolCalls: streamingAssistant.content.filter((b) => b.type === "toolCall").length,
			hasThinking: streamingAssistant.content.some((b) => b.type === "thinking"),
			streaming: true,
		});
	}
	return items.sort((a, b) => a.timestamp - b.timestamp || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

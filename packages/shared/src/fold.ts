/**
 * Session state machine: fold a stream of `JsonAgentSessionEvent` (pi RPC/JSON
 * wire lines) into a canonical `SessionState` that the graph derivation
 * (graph.ts) renders.
 *
 * Key wire rules this file implements (see types.ts header for sources):
 * - `message_update` is delta-only. Assistant messages are rebuilt by applying
 *   `assistantMessageEvent` deltas onto the `message_start` snapshot; the
 *   `message_end` message is authoritative.
 * - Tool executions are tracked by `toolCallId`, and the owning assistant
 *   message is the last assistant message whose content contains a toolCall
 * block with that id.
 * - pi events carry no timestamps on tool_execution_*; we stamp locally on
 *   receipt (callers pass `now` — kept injectable for deterministic tests).
 */

import type {
	AssistantContent,
	AssistantMessage,
	JsonAgentSessionEvent,
	JsonAssistantMessageEvent,
	Message,
	SubagentDetails,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultPayload,
	Usage,
} from "./types.ts";

// ============================================================================
// State
// ============================================================================

export interface ToolExecutionState {
	toolCallId: string;
	toolName: string;
	args: any;
	/** Owning assistant message id, once resolved (see resolveOwner). */
	ownerAssistantId: string | null;
	status: "running" | "ok" | "error";
	startedAt: number;
	endedAt: number | null;
	/** Latest partialResult payload (subagent progress lives here). */
	partialResult: any;
	/** Final result payload from tool_execution_end. */
	result: any;
	isError: boolean;
}

export interface SessionState {
	/** All completed messages in transcript order. */
	messages: Message[];
	/** Assistant message currently being streamed (also mirrored into messages on message_end). */
	streamingAssistant: AssistantMessage | null;
	/** Folding bookkeeping: current message_start snapshot + open text/thinking/toolcall blocks. */
	streamingDraft: StreamingDraft | null;
	tools: Map<string, ToolExecutionState>;
	/** Cumulative usage across assistant messages. */
	usageTotal: Usage;
	agentStatus: "idle" | "running";
	/** Monotonic event counter, handy for stable node ids. */
	seq: number;
	/** Set when agent_end reports a failed/aborted run that will not retry. */
	lastError: string | null;
}

export interface StreamingDraft {
	/** Snapshot from message_start (role must be assistant for message_update). */
	base: AssistantMessage;
	content: AssistantContent[];
	/** Open text block index, if any. */
	openTextIndex: number | null;
	/** Open thinking block index, if any. */
	openThinkingIndex: number | null;
	/** Open toolCall block index, if any. */
	openToolCallIndex: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(total: Usage, delta: Usage): Usage {
	total.input += delta.input || 0;
	total.output += delta.output || 0;
	total.cacheRead += delta.cacheRead || 0;
	total.cacheWrite += delta.cacheWrite || 0;
	total.cacheWrite1h = (total.cacheWrite1h || 0) + (delta.cacheWrite1h || 0) || undefined;
	total.totalTokens += delta.totalTokens || 0;
	if (delta.cost) {
		total.cost.input += delta.cost.input || 0;
		total.cost.output += delta.cost.output || 0;
		total.cost.cacheRead += delta.cost.cacheRead || 0;
		total.cost.cacheWrite += delta.cost.cacheWrite || 0;
		total.cost.total += delta.cost.total || 0;
	}
	return total;
}

export function initState(): SessionState {
	return {
		messages: [],
		streamingAssistant: null,
		streamingDraft: null,
		tools: new Map(),
		usageTotal: emptyUsage(),
		agentStatus: "idle",
		seq: 0,
		lastError: null,
	};
}

function messageId(message: Message): string {
	// pi messages have no id field; synthesize a stable one from role+timestamp.
	// Timestamps are millisecond-unique per message in practice; seq fallback
	// guards collisions.
	return `${message.role}:${message.timestamp}`;
}

/** Apply one wire delta to the streaming draft. Mutates draft.content. */
function applyDelta(draft: StreamingDraft, event: JsonAssistantMessageEvent): void {
	switch (event.type) {
		case "start":
			return;
		case "text_start": {
			draft.content[event.contentIndex] = { type: "text", text: "" };
			draft.openTextIndex = event.contentIndex;
			draft.openThinkingIndex = null;
			draft.openToolCallIndex = null;
			return;
		}
		case "text_delta": {
			const block = draft.content[event.contentIndex];
			if (block?.type === "text") block.text += event.delta;
			return;
		}
		case "text_end": {
			const block = draft.content[event.contentIndex];
			if (block?.type === "text") block.text = event.content;
			draft.openTextIndex = null;
			return;
		}
		case "thinking_start": {
			draft.content[event.contentIndex] = { type: "thinking", thinking: "" };
			draft.openThinkingIndex = event.contentIndex;
			draft.openTextIndex = null;
			draft.openToolCallIndex = null;
			return;
		}
		case "thinking_delta": {
			const block = draft.content[event.contentIndex];
			if (block?.type === "thinking") block.thinking += event.delta;
			return;
		}
		case "thinking_end": {
			const block = draft.content[event.contentIndex];
			if (block?.type === "thinking") block.thinking = event.content;
			draft.openThinkingIndex = null;
			return;
		}
		case "toolcall_start": {
			const call: ToolCall = {
				type: "toolCall",
				id: event.id,
				name: event.toolName,
				arguments: {},
			};
			draft.content[event.contentIndex] = call;
			draft.openToolCallIndex = event.contentIndex;
			draft.openTextIndex = null;
			draft.openThinkingIndex = null;
			return;
		}
		case "toolcall_delta": {
			// Tool-call arguments arrive as JSON text fragments; accumulate into
			// a buffer on the block and parse at toolcall_end. We store raw text
			// on a side field of the draft to keep ToolCall JSON-clean.
			const block = draft.content[event.contentIndex];
			if (block?.type === "toolCall") {
				draft.toolCallArgBuffers[event.contentIndex] =
					(draft.toolCallArgBuffers[event.contentIndex] || "") + event.delta;
			}
			return;
		}
		case "toolcall_end": {
			// event.toolCall is the authoritative parsed block.
			draft.content[event.contentIndex] = event.toolCall;
			delete draft.toolCallArgBuffers[event.contentIndex];
			draft.openToolCallIndex = null;
			return;
		}
	}
}

/** Build the current folded assistant message from the draft (without ending it). */
function draftToMessage(draft: StreamingDraft): AssistantMessage {
	return {
		...draft.base,
		// Sparse contentIndex writes can leave holes; drop anything that is not
		// a recognized content block.
		content: draft.content
			.filter((block): block is NonNullable<typeof block> => block != null && typeof block.type === "string")
			.map((block) => ({ ...block })),
	};
}

// Extend StreamingDraft with the argument buffers (kept internal).
export interface StreamingDraft {
	base: AssistantMessage;
	content: AssistantContent[];
	openTextIndex: number | null;
	openThinkingIndex: number | null;
	openToolCallIndex: number | null;
	toolCallArgBuffers: Record<number, string>;
}

// ============================================================================
// Fold
// ============================================================================

/**
 * Fold one wire event into the session state (mutating it). Returns the same
 * state for chaining. Unknown/ignored event types are counted in `seq` only.
 */
export function foldEvent(state: SessionState, event: JsonAgentSessionEvent, now: number = Date.now()): SessionState {
	state.seq++;
	switch (event.type) {
		case "agent_start": {
			state.agentStatus = "running";
			state.lastError = null;
			return state;
		}
		case "agent_end": {
			state.agentStatus = "running"; // settlement is signaled by agent_settled
			if (!event.willRetry) {
				// Surface failed runs. User-initiated aborts carry errorMessage
				// too but are not failures — skip stopReason "aborted".
				for (let i = event.messages.length - 1; i >= 0; i--) {
					const m = event.messages[i];
					if (m?.role === "assistant" && m.stopReason === "error" && m.errorMessage) {
						state.lastError = m.errorMessage;
						break;
					}
				}
			}
			return state;
		}
		case "agent_settled": {
			state.agentStatus = "idle";
			state.streamingAssistant = null;
			state.streamingDraft = null;
			return state;
		}
		case "message_start": {
			if (event.message.role === "assistant") {
				state.streamingDraft = {
					base: event.message,
					content: event.message.content.map((b) => ({ ...b })),
					openTextIndex: null,
					openThinkingIndex: null,
					openToolCallIndex: null,
					toolCallArgBuffers: {},
				};
				state.streamingAssistant = event.message;
			}
			// Non-assistant (user/toolResult) messages are appended on their
			// message_end — pi emits start+end back-to-back for them, so pushing
			// here would double every entry.
			return state;
		}
		case "message_update": {
			const draft = state.streamingDraft;
			if (!draft) return state; // update without start (shouldn't happen on rpc)
			applyDelta(draft, event.assistantMessageEvent);
			state.streamingAssistant = draftToMessage(draft);
			// event.usage is the CUMULATIVE per-message snapshot on the wire —
			// do not accumulate into usageTotal here (message_end adds it once).
			state.streamingAssistant.usage = event.usage;
			return state;
		}
		case "message_end": {
			// Authoritative final message — the only place messages are appended.
			state.messages.push(event.message);
			if (event.message.role === "assistant") {
				addUsage(state.usageTotal, event.message.usage);
				state.streamingDraft = null;
				state.streamingAssistant = null;
				// Tool executions may have started before message_end (pi emits
				// tool_execution_start after the assistant message ends in most
				// cases, but resolve owners defensively for any that started early).
				resolveToolOwners(state);
			}
			return state;
		}
		case "tool_execution_start": {
			state.tools.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				ownerAssistantId: null,
				status: "running",
				startedAt: now,
				endedAt: null,
				partialResult: null,
				result: null,
				isError: false,
			});
			resolveToolOwners(state);
			return state;
		}
		case "tool_execution_update": {
			const tool = state.tools.get(event.toolCallId);
			if (tool) tool.partialResult = event.partialResult;
			return state;
		}
		case "tool_execution_end": {
			const tool = state.tools.get(event.toolCallId);
			if (tool) {
				tool.result = event.result;
				tool.isError = event.isError;
				tool.status = event.isError ? "error" : "ok";
				tool.endedAt = now;
			}
			return state;
		}
		default:
			// turn_start/turn_end, queue/compaction/retry/persistence events:
			// persisted in seq count; graph.ts reads what it needs from state.
			return state;
	}
}

/**
 * Resolve ownerAssistantId for tools that have none: the most recent assistant
 * message containing a toolCall block with the matching id.
 */
function resolveToolOwners(state: SessionState): void {
	// The in-flight streaming assistant can already contain toolCall blocks —
	// check it first so ownership resolves during streaming.
	const candidates: Array<{ m: AssistantMessage; id: string } | null> = [];
	if (state.streamingAssistant) candidates.push({ m: state.streamingAssistant, id: messageId(state.streamingAssistant) });
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m?.role === "assistant") candidates.push({ m, id: messageId(m) });
	}
	for (const tool of state.tools.values()) {
		if (tool.ownerAssistantId !== null) continue;
		for (const c of candidates) {
			if (c && c.m.content.some((b) => b.type === "toolCall" && b.id === tool.toolCallId)) {
				tool.ownerAssistantId = c.id;
				break;
			}
		}
	}
}

/** Stable id for a transcript message (mirrors fold-internal messageId). */
export function getMessageId(message: Message): string {
	return messageId(message);
}

// ============================================================================
// Subagent details extraction
// ============================================================================

/**
 * Extract SubagentDetails from a subagent tool execution's latest payload
 * (partialResult while running, result once ended). Returns null for
 * non-subagent tools or malformed payloads.
 */
export function extractSubagentDetails(tool: ToolExecutionState): SubagentDetails | null {
	if (tool.toolName !== "subagent") return null;
	const payload: ToolResultPayload | null | undefined =
		tool.result ?? tool.partialResult ?? null;
	const details = payload && typeof payload === "object" ? (payload as ToolResultPayload).details : undefined;
	if (!details || typeof details !== "object" || !Array.isArray((details as SubagentDetails).results)) {
		return null;
	}
	return details as SubagentDetails;
}

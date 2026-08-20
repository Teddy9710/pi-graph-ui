/**
 * pi-graph shared types.
 *
 * These mirror the wire shapes emitted by `pi --mode rpc` / `pi --mode json`
 * (pi-mono @ b7bb00b93), i.e. the *JSON-serialized* forms, not the in-process
 * ones:
 *
 * - `JsonAgentSessionEvent` — one JSON line on stdout. `message_update` is
 *   delta-only (no cumulative message snapshot); see fold.ts for rebuilding.
 * - Messages/content blocks match `@earendil-works/pi-ai` types.ts with
 *   non-JSON fields (undefined/Date) absent on the wire.
 * - Tool events carry only `toolCallId` — there is NO agentId/parentId in pi's
 *   event model. Parent/child relationships are derived in graph.ts.
 *
 * Source of truth (pi-mono paths):
 *   packages/agent/src/types.ts                    — AgentEvent
 *   packages/coding-agent/src/core/agent-session.ts — AgentSessionEvent extras
 *   packages/coding-agent/src/modes/json-event.ts   — wire transform rules
 *   packages/ai/src/types.ts                       — Message/content/Usage
 *   packages/coding-agent/examples/extensions/subagent/index.ts — SubagentDetails
 */

// ============================================================================
// Content blocks (pi-ai types.ts)
// ============================================================================

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string;
	namespace?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type UserContent = TextContent | ImageContent;

// ============================================================================
// Usage (pi-ai types.ts) — all JSON-safe
// ============================================================================

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

// ============================================================================
// Messages (pi-ai types.ts)
// ============================================================================

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: any;
	usage?: Usage;
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ============================================================================
// Assistant streaming deltas (pi-ai AssistantMessageEvent, WIRE form)
//
// On the wire, `toJsonAssistantMessageEvent` strips the cumulative `partial`
// snapshot from every delta. `toolcall_start` additionally gains `id` and
// `toolName` extracted from the partial snapshot.
// ============================================================================

export type JsonAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };

// ============================================================================
// AgentSessionEvent (wire form — JsonAgentSessionEvent)
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One JSON line from `pi --mode rpc` stdout.
 *
 * Note: `entry_appended.entry`, `compaction_end.result`, and custom messages
 * are modeled loosely (`any`) — they are persisted but not needed to drive the
 * graph.
 */
export type JsonAgentSessionEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[]; willRetry: boolean }
	| { type: "agent_settled" }
	// Turn lifecycle
	| { type: "turn_start" }
	| { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
	// Message lifecycle. message_start/end carry full messages for
	// user/assistant/toolResult roles; message_update is delta-only for
	// assistant streaming.
	| { type: "message_start"; message: Message }
	| { type: "message_update"; usage: Usage; assistantMessageEvent: JsonAssistantMessageEvent }
	| { type: "message_end"; message: Message }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
	// Queue / steering
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
	// Compaction
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: any; aborted: boolean; willRetry: boolean; errorMessage?: string }
	// Persistence / info
	| { type: "entry_appended"; entry: any }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	// Auto retry
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual" | "threshold" | "overflow" }
	| { type: "summarization_retry_finished" }
	// Live bash output stream
	| { type: "bash_execution_update"; id?: string; delta: string };

// ============================================================================
// Subagent extension details (examples/extensions/subagent/index.ts)
// ============================================================================

/** Aggregated usage tracked per subagent by the extension (NOT pi-ai Usage). */
export interface SubagentUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** One subagent invocation result. `exitCode === -1` means still running. */
export interface SubagentSingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: SubagentUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** 1-based step number in chain mode. */
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: "user" | "project" | "both";
	projectAgentsDir: string | null;
	results: SubagentSingleResult[];
}

/** Shape of AgentToolResult on the wire (tool_execution_* payload). */
export interface ToolResultPayload {
	content: (TextContent | ImageContent)[];
	details?: any;
	usage?: Usage;
	addedToolNames?: string[];
	terminate?: boolean;
}

// ============================================================================
// RPC commands (stdin side of `pi --mode rpc`) — the subset we send
// ============================================================================

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" };

/** RPC response envelope: bare object with matching `id` on stdout. */
export interface RpcResponse {
	id?: string;
	ok?: boolean;
	result?: unknown;
	error?: unknown;
	[k: string]: unknown;
}

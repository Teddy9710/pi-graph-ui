/**
 * Graph derivation: turn a folded SessionState into React Flow nodes/edges.
 *
 * Node kinds and edges:
 *
 *   session ── user ── assistant ──┬── tool(read/bash/...)
 *                                 └── subagent-call ── agent(research-A) ── agent-tool(...)
 *                                                   └── agent(research-B) ── ...
 *
 * - One node per user message, assistant message (final or streaming), and
 *   tool execution.
 * - A `subagent` tool execution additionally fans out one `agent` node per
 *   SubagentSingleResult (parallel mode = siblings; chain mode results keep
 *   step order via edges subagent-call -> step1 -> step2 ... when steps are
 *   known), and one `agent-tool` node per toolCall block inside each result's
 *   messages (second-level activity, derived from message transcripts since
 *   child processes never emit events into the parent stream).
 * - Timestamps/durations come from local receipt stamping in fold.ts.
 */

import type { SessionState, ToolExecutionState } from "./fold.ts";
import { extractSubagentDetails, getMessageId } from "./fold.ts";
import type { AssistantMessage, Message, SubagentDetails, SubagentSingleResult, ToolCall, UserMessage } from "./types.ts";

// ============================================================================
// React Flow shape (structural subset — @xyflow/react types are provided by
// the web app; keeping this dependency-free lets server & tests use it too)
// ============================================================================

export type NodeStatus = "pending" | "running" | "ok" | "error";

export interface GraphNodeData {
	kind:
		| "session"
		| "user"
		| "assistant"
		| "tool"
		| "subagent-call"
		| "agent"
		| "agent-tool";
	status: NodeStatus;
	label: string;
	/** Free-form detail payload for the detail panel. */
	detail?: unknown;
	startedAt?: number;
	endedAt?: number;
	toolCallId?: string;
	messageId?: string;
	/** agent nodes: index within the subagent results array. */
	agentIndex?: number;
}

export interface GraphNode {
	id: string;
	type: string; // React Flow node type key (custom renderers in web app)
	position: { x: number; y: number }; // filled by layout; (0,0) until then
	data: GraphNodeData;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	/** "flow" = transcript order, "spawn" = agent fan-out, "summary" = fan-in. */
	kind: "flow" | "spawn" | "summary";
}

export interface Graph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

// ============================================================================
// Derivation
// ============================================================================

function nodeStatusFromMessage(message: AssistantMessage): NodeStatus {
	if (message.stopReason === "error" || message.stopReason === "aborted") return "error";
	if (message.stopReason === "pending") return "running";
	return "ok";
}

function toolLabel(toolName: string, args: Record<string, any> | undefined | null): string {
	const a = args || {};
	switch (toolName) {
		case "bash":
			return `$ ${String(a.command ?? "").slice(0, 60)}`;
		case "read":
		case "write":
		case "edit":
			return `${toolName} ${String(a.file_path ?? a.path ?? "")}`;
		case "ls":
			return `ls ${String(a.path ?? ".")}`;
		case "find":
			return `find ${String(a.pattern ?? "*")}`;
		case "grep":
			return `grep /${String(a.pattern ?? "")}/`;
		default:
			return toolName;
	}
}

function userLabel(message: UserMessage): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map((b) => b.text)
					.join("\n");
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

function assistantLabel(message: AssistantMessage): string {
	const text = message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine) return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
	const toolCalls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
	if (toolCalls.length > 0) return `→ ${toolCalls.map((t) => t.name).join(", ")}`;
	return "(thinking…)";
}

function agentResultStatus(result: SubagentSingleResult, toolRunning: boolean): NodeStatus {
	if (result.exitCode === -1) return "running";
	// In single/chain modes the extension streams in-flight results with
	// exitCode 0 and no stopReason — treat them as running while the tool runs.
	if (toolRunning && result.stopReason === undefined) return "running";
	const failed =
		result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	return failed ? "error" : "ok";
}

/** toolCall blocks from a subagent result's transcript, in order. */
function resultToolCalls(result: SubagentSingleResult): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const m of result.messages) {
		if (m.role !== "assistant") continue;
		for (const b of m.content) {
			if (b.type === "toolCall") calls.push(b);
		}
	}
	return calls;
}

/** Last assistant text of a subagent result — its "final answer". */
function resultSummary(result: SubagentSingleResult): string {
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const m = result.messages[i];
		if (m?.role !== "assistant") continue;
		const text = m.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) {
			const oneLine = text.replace(/\s+/g, " ");
			return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
		}
	}
	return "";
}

/**
 * Derive the full graph from session state. Pure: builds fresh arrays each
 * call; React Flow consumers should diff by node/edge id.
 */
export function deriveGraph(state: SessionState): Graph {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];

	const sessionId = "session";
	nodes.push({
		id: sessionId,
		type: "session",
		position: { x: 0, y: 0 },
		data: {
			kind: "session",
			status: state.agentStatus === "running" ? "running" : "ok",
			label: "session",
			detail: {
				usage: state.usageTotal,
				messageCount: state.messages.length,
				toolCount: state.tools.size,
				lastError: state.lastError,
			},
		},
	});

	// Transcript walk: user / assistant(/streaming) nodes in order; edges
	// connect each node to the previous transcript node.
	let prevFlowId = sessionId;
	const toolNodesPending: string[] = []; // transcript node ids awaiting tool fan-out

	// Include the in-flight streaming assistant at the end of the transcript.
	const transcript: Message[] = [...state.messages];
	if (state.streamingAssistant) transcript.push(state.streamingAssistant);

	// Tools ordered by start (Map preserves insertion order).
	const tools = [...state.tools.values()];

	for (const message of transcript) {
		const mid = getMessageId(message);
		if (message.role === "user") {
			const id = `user:${mid}`;
			nodes.push({
				id,
				type: "user",
				position: { x: 0, y: 0 },
				data: { kind: "user", status: "ok", label: userLabel(message), messageId: mid, detail: message },
			});
			edges.push({ id: `e:${prevFlowId}->${id}`, source: prevFlowId, target: id, kind: "flow" });
			prevFlowId = id;
			toolNodesPending.length = 0;
		} else if (message.role === "assistant") {
			const id = `assistant:${mid}`;
			nodes.push({
				id,
				type: "assistant",
				position: { x: 0, y: 0 },
				data: {
					kind: "assistant",
					status: nodeStatusFromMessage(message),
					label: assistantLabel(message),
					messageId: mid,
					detail: message,
				},
			});
			edges.push({ id: `e:${prevFlowId}->${id}`, source: prevFlowId, target: id, kind: "flow" });
			prevFlowId = id;
		}
		// toolResult messages are represented by their tool nodes' statuses.
	}

	// Tool fan-out: each tool hangs off its owning assistant node (or the last
	// transcript node if the owner can't be resolved yet).
	for (const tool of tools) {
		const ownerKey = tool.ownerAssistantId
			? `assistant:${tool.ownerAssistantId}`
			: prevFlowId;
		const details = extractSubagentDetails(tool);
		if (details) {
			deriveSubagentBranch(nodes, edges, tool, details, ownerKey);
		} else {
			const id = `tool:${tool.toolCallId}`;
			nodes.push({
				id,
				type: "tool",
				position: { x: 0, y: 0 },
				data: {
					kind: "tool",
					status: tool.status,
					label: toolLabel(tool.toolName, tool.args),
					toolCallId: tool.toolCallId,
					startedAt: tool.startedAt,
					endedAt: tool.endedAt ?? undefined,
					detail: tool,
				},
			});
			edges.push({ id: `e:${ownerKey}->${id}`, source: ownerKey, target: id, kind: "flow" });
		}
	}

	return { nodes, edges };
}

/** Fan out subagent-call -> agent(s) -> agent-tool nodes for one subagent tool execution. */
function deriveSubagentBranch(
	nodes: GraphNode[],
	edges: GraphEdge[],
	tool: ToolExecutionState,
	details: SubagentDetails,
	ownerKey: string,
): void {
	const callId = `subagent:${tool.toolCallId}`;
	const runningCount = details.results.filter((r) => r.exitCode === -1).length;
	nodes.push({
		id: callId,
		type: "subagent-call",
		position: { x: 0, y: 0 },
		data: {
			kind: "subagent-call",
			status: tool.status,
			label:
				details.mode === "parallel"
					? `subagent · parallel (${details.results.length}${runningCount > 0 ? `, ${runningCount} running` : ""})`
					: details.mode === "chain"
						? `subagent · chain (${details.results.length} steps)`
						: `subagent · ${details.results[0]?.agent ?? "…"}`,
			toolCallId: tool.toolCallId,
			startedAt: tool.startedAt,
			endedAt: tool.endedAt ?? undefined,
			detail: tool,
		},
	});
	edges.push({ id: `e:${ownerKey}->${callId}`, source: ownerKey, target: callId, kind: "flow" });

	if (details.mode === "chain") {
		// Chain: step results are sequential; connect call -> step1 -> step2...
		let prevId = callId;
		details.results.forEach((result, index) => {
			const id = `agent:${tool.toolCallId}:${index}`;
			nodes.push({
				id,
				type: "agent",
				position: { x: 0, y: 0 },
				data: {
					kind: "agent",
					status: agentResultStatus(result, tool.status === "running"),
					label: `${index + 1}. ${result.agent}`,
					agentIndex: index,
					detail: { result, summary: resultSummary(result), usage: result.usage, model: result.model },
				},
			});
			edges.push({ id: `e:${prevId}->${id}`, source: prevId, target: id, kind: "spawn" });
			prevId = id;
			deriveAgentTools(nodes, edges, id, result);
		});
		return;
	}

	// single / parallel: fan out siblings from the call node.
	details.results.forEach((result, index) => {
		const id = `agent:${tool.toolCallId}:${index}`;
		const status = agentResultStatus(result, tool.status === "running");
		nodes.push({
			id,
			type: "agent",
			position: { x: 0, y: 0 },
			data: {
				kind: "agent",
				status,
				label: result.agent,
				agentIndex: index,
				detail: {
					result,
					summary: resultSummary(result),
					usage: result.usage,
					model: result.model,
					running: status === "running",
				},
			},
		});
		edges.push({ id: `e:${callId}->${id}`, source: callId, target: id, kind: "spawn" });
		deriveAgentTools(nodes, edges, id, result);
	});
}

/** One agent-tool node per toolCall in the subagent result transcript. */
function deriveAgentTools(
	nodes: GraphNode[],
	edges: GraphEdge[],
	agentNodeId: string,
	result: SubagentSingleResult,
): void {
	resultToolCalls(result).forEach((call, index) => {
		const id = `${agentNodeId}:t${index}`;
		nodes.push({
			id,
			type: "agent-tool",
			position: { x: 0, y: 0 },
			data: {
				kind: "agent-tool",
				status: "ok",
				label: toolLabel(call.name, call.arguments),
				toolCallId: call.id,
				detail: call,
			},
		});
		edges.push({ id: `e:${agentNodeId}->${id}`, source: agentNodeId, target: id, kind: "flow" });
	});
}

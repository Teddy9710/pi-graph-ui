import { describe, expect, it } from "vitest";
import { extractSubagentDetails, foldEvent, getMessageId, initState } from "../src/fold.ts";
import type { AssistantMessage, JsonAgentSessionEvent, Usage } from "../src/types.ts";

function usage(over: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...over,
	};
}

function assistantBase(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: usage(),
		stopReason: "pending",
		timestamp: 1000,
		...over,
	};
}

/** Fold a scripted sequence of wire events with a deterministic clock. */
function foldAll(events: JsonAgentSessionEvent[]) {
	const state = initState();
	let clock = 0;
	for (const e of events) foldEvent(state, e, ++clock);
	return state;
}

const userPromptEvents: JsonAgentSessionEvent[] = [
	{ type: "message_start", message: { role: "user", content: "调研 React Flow", timestamp: 1 } },
];

const streamEvents: JsonAgentSessionEvent[] = [
	{ type: "agent_start" },
	...userPromptEvents,
	{ type: "message_start", message: assistantBase() },
	{ type: "message_update", usage: usage({ output: 1 }), assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
	{ type: "message_update", usage: usage({ output: 2 }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "我先" } },
	{ type: "message_update", usage: usage({ output: 3 }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "读文件" } },
	{ type: "message_update", usage: usage({ output: 4 }), assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "我先读文件" } },
	{
		type: "message_update",
		usage: usage({ output: 5 }),
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "tc_1", toolName: "read" },
	},
	{
		type: "message_update",
		usage: usage({ output: 6 }),
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"file_path":"a.ts"}' },
	},
	{
		type: "message_update",
		usage: usage({ output: 7 }),
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "tc_1", name: "read", arguments: { file_path: "a.ts" } },
		},
	},
	{
		type: "message_end",
		message: assistantBase({
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "我先读文件" },
				{ type: "toolCall", id: "tc_1", name: "read", arguments: { file_path: "a.ts" } },
			],
		}),
	},
	{ type: "tool_execution_start", toolCallId: "tc_1", toolName: "read", args: { file_path: "a.ts" } },
	{
		type: "tool_end_placeholder" as never,
	},
].filter((e) => (e as { type: string }).type !== "tool_end_placeholder") as JsonAgentSessionEvent[];

describe("fold: streaming assistant reconstruction", () => {
	it("rebuilds text and toolCall blocks from delta-only message_update events", () => {
		const state = foldAll(streamEvents.slice(0, 9)); // up to toolcall_end
		const streaming = state.streamingAssistant;
		expect(streaming).not.toBeNull();
		const text = streaming!.content[0];
		expect(text?.type === "text" && text.text).toBe("我先读文件");
		const call = streaming!.content[1];
		expect(call?.type === "toolCall" && call.id).toBe("tc_1");
		expect(call?.type === "toolCall" && call.name).toBe("read");
	});

	it("does NOT accumulate usage from message_update (cumulative snapshots)", () => {
		const state = foldAll(streamEvents);
		// message_update usage is the per-message cumulative snapshot; only the
		// final message_end usage (output: 0) is counted.
		expect(state.usageTotal.output).toBe(0);
		// The streaming view carries the latest cumulative snapshot instead.
		const partial = foldAll(streamEvents.slice(0, 6));
		expect(partial.streamingAssistant?.usage.output).toBe(3);
	});

	it("message_end is authoritative and clears streaming state", () => {
		const state = foldAll(streamEvents);
		expect(state.streamingAssistant).toBeNull();
		expect(state.streamingDraft).toBeNull();
		const last = state.messages.at(-1);
		expect(last?.role).toBe("assistant");
	});

	it("user messages are appended exactly once (start+end both emitted)", () => {
		// pi emits message_start AND message_end back-to-back for user messages.
		const state = foldAll([
			{ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
		]);
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.role).toBe("user");
	});

	it("aborted runs do not set lastError (only stopReason error does)", () => {
		const state = foldAll([
			{ type: "agent_start" },
			{
				type: "agent_end",
				messages: [assistantBase({ stopReason: "aborted", errorMessage: "user abort" })],
				willRetry: false,
			},
			{ type: "agent_settled" },
		]);
		expect(state.lastError).toBeNull();
	});
});

describe("fold: tool execution lifecycle", () => {
	const toolEvents: JsonAgentSessionEvent[] = [
		...streamEvents,
		{ type: "tool_execution_start", toolCallId: "tc_1", toolName: "read", args: { file_path: "a.ts" } },
		{
			type: "tool_execution_update",
			toolCallId: "tc_1",
			toolName: "read",
			args: { file_path: "a.ts" },
			partialResult: { content: [{ type: "text", text: "line1" }], details: undefined },
		},
		{
			type: "tool_execution_end",
			toolCallId: "tc_1",
			toolName: "read",
			result: { content: [{ type: "text", text: "file contents" }], details: undefined },
			isError: false,
		},
	];

	it("tracks running -> ok with timestamps and partials", () => {
		const state = foldAll(toolEvents);
		const tool = state.tools.get("tc_1")!;
		expect(tool.status).toBe("ok");
		expect(tool.startedAt).toBeGreaterThan(0);
		expect(tool.endedAt).toBeGreaterThanOrEqual(tool.startedAt);
		expect(tool.partialResult).toBeDefined();
		expect(tool.result).toBeDefined();
	});

	it("attributes the tool to the assistant message containing its toolCall id", () => {
		const state = foldAll(toolEvents);
		const tool = state.tools.get("tc_1")!;
		const owner = state.messages.find(
			(m) => getMessageId(m) === tool.ownerAssistantId,
		);
		expect(owner?.role).toBe("assistant");
		expect(
			owner?.role === "assistant" && owner.content.some((b) => b.type === "toolCall" && b.id === "tc_1"),
		).toBe(true);
	});

	it("records error status from tool_execution_end", () => {
		const state = foldAll([
			...streamEvents,
			{
				type: "tool_execution_end",
				toolCallId: "tc_1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "boom" }], details: undefined },
				isError: true,
			},
		]);
		expect(state.tools.get("tc_1")?.status).toBe("error");
	});
});

describe("fold: agent lifecycle", () => {
	it("agent_start/agent_settled toggle status; agent_end with error message is surfaced", () => {
		const state = foldAll([
			{ type: "agent_start" },
			{
				type: "agent_end",
				messages: [assistantBase({ stopReason: "error", errorMessage: "api down" })],
				willRetry: false,
			},
			{ type: "agent_settled" },
		]);
		expect(state.agentStatus).toBe("idle");
		expect(state.lastError).toBe("api down");
	});

	it("willRetry runs keep lastError cleared", () => {
		const state = foldAll([
			{ type: "agent_start" },
			{
				type: "agent_end",
				messages: [assistantBase({ stopReason: "error", errorMessage: "rate limited" })],
				willRetry: true,
			},
		]);
		expect(state.lastError).toBeNull();
	});

	it("sparse contentIndex writes do not produce undefined holes", () => {
		const state = foldAll([
			{ type: "message_start", message: assistantBase() },
			{
				type: "message_update",
				usage: usage(),
				assistantMessageEvent: { type: "text_start", contentIndex: 2 },
			},
			{
				type: "message_update",
				usage: usage(),
				assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "late block" },
			},
		]);
		const streaming = state.streamingAssistant!;
		expect(streaming.content).toHaveLength(1);
		expect(streaming.content[0]?.type).toBe("text");
		expect(streaming.content[0]?.type === "text" && streaming.content[0].text).toBe("late block");
	});
});

describe("extractSubagentDetails", () => {
	const subagentTool = {
		toolCallId: "tc_sub",
		toolName: "subagent",
		args: {},
		ownerAssistantId: null,
		status: "running" as const,
		startedAt: 1,
		endedAt: null,
		partialResult: null,
		result: null,
		isError: false,
	};

	it("reads details from partialResult while running and result once ended", () => {
		const details = {
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{
					agent: "researcher",
					agentSource: "user",
					task: "查 A",
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				},
			],
		};
		const running = { ...subagentTool, partialResult: { content: [], details } };
		expect(extractSubagentDetails(running)?.results[0]?.agent).toBe("researcher");
		const done = { ...subagentTool, partialResult: null, result: { content: [], details } };
		expect(extractSubagentDetails(done)?.results[0]?.agent).toBe("researcher");
	});

	it("returns null for non-subagent tools and malformed payloads", () => {
		expect(extractSubagentDetails({ ...subagentTool, toolName: "read" })).toBeNull();
		expect(extractSubagentDetails({ ...subagentTool, partialResult: { content: [] } })).toBeNull();
	});
});

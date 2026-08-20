import { describe, expect, it } from "vitest";
import { deriveGraph } from "../src/graph.ts";
import { foldEvent, initState, type SessionState } from "../src/fold.ts";
import type { JsonAgentSessionEvent, Message, SubagentDetails } from "../src/types.ts";

function foldAll(events: JsonAgentSessionEvent[]): SessionState {
	const state = initState();
	let clock = 0;
	for (const e of events) foldEvent(state, e, ++clock);
	return state;
}

function ids(graph: { nodes: { id: string }[] }): string[] {
	return graph.nodes.map((n) => n.id);
}

function node(graph: ReturnType<typeof deriveGraph>, id: string) {
	return graph.nodes.find((n) => n.id === id);
}

const baseAssistant = {
	role: "assistant",
	content: [] as any[],
	api: "anthropic",
	provider: "anthropic",
	model: "claude-sonnet-4",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 2000,
} as const;

const assistantWithSubagentCall: Message = {
	...baseAssistant,
	content: [
		{ type: "text", text: "我派几个子 agent 调研" },
		{ type: "toolCall", id: "tc_sub", name: "subagent", arguments: {} },
	],
};

function subagentDetails(results: Array<Partial<SubagentDetails["results"][number]>>): SubagentDetails {
	return {
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		results: results.map((r, i) => ({
			agent: `researcher-${i}`,
			agentSource: "user",
			task: `task-${i}`,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			...r,
		})),
	};
}

/** A full parallel-research scenario: user asks -> assistant spawns subagents. */
function researchScenario(): JsonAgentSessionEvent[] {
	const detailsA = subagentDetails([
		{
			agent: "调研A",
			messages: [
				{
					...baseAssistant,
					content: [
						{ type: "text", text: "用 grep 找" },
						{ type: "toolCall", id: "sub_tc_1", name: "grep", arguments: { pattern: "deriveGraph" } },
					],
				},
			],
		},
		{ agent: "调研B", exitCode: -1, messages: [] },
	]);
	const events: JsonAgentSessionEvent[] = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "user", content: "调研一下", timestamp: 1000 } },
		{ type: "message_start", message: assistantWithSubagentCall },
		{ type: "message_end", message: assistantWithSubagentCall },
		{ type: "tool_execution_start", toolCallId: "tc_sub", toolName: "subagent", args: {} },
		{
			type: "tool_execution_update",
			toolCallId: "tc_sub",
			toolName: "subagent",
			args: {},
			partialResult: { content: [{ type: "text", text: "Parallel: 0/2 done" }], details: detailsA },
		},
	];
	return events;
}

describe("deriveGraph: structure", () => {
	it("emits session -> user -> assistant -> tool chain for a simple turn", () => {
		const state = foldAll([
			{ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message_end",
				message: {
					...baseAssistant,
					stopReason: "stop",
					content: [{ type: "text", text: "你好" }],
					timestamp: 2,
				},
			},
		]);
		const graph = deriveGraph(state);
		expect(ids(graph)).toEqual(
			expect.arrayContaining(["session", "user:user:1", "assistant:assistant:2"]),
		);
		const flowEdges = graph.edges.filter((e) => e.kind === "flow");
		expect(flowEdges.map((e) => `${e.source}->${e.target}`)).toEqual([
			"session->user:user:1",
			"user:user:1->assistant:assistant:2",
		]);
	});

	it("attaches tool nodes to the owning assistant", () => {
		const state = foldAll([
			{ type: "message_start", message: { role: "user", content: "read it", timestamp: 1 } },
			{
				type: "message_end",
				message: {
					...baseAssistant,
					content: [{ type: "toolCall", id: "tc_9", name: "read", arguments: { file_path: "x.ts" } }],
					timestamp: 2,
				},
			},
			{ type: "tool_execution_start", toolCallId: "tc_9", toolName: "read", args: { file_path: "x.ts" } },
		]);
		const graph = deriveGraph(state);
		expect(node(graph, "tool:tc_9")?.data.label).toBe("read x.ts");
		expect(graph.edges.some((e) => e.source === "assistant:assistant:2" && e.target === "tool:tc_9")).toBe(true);
	});

	it("includes the streaming assistant as a running node", () => {
		const state = initState();
		foldEvent(state, { type: "message_start", message: { ...baseAssistant, content: [], stopReason: "pending", timestamp: 5 } });
		const graph = deriveGraph(state);
		const streamingNode = graph.nodes.find((n) => n.data.kind === "assistant");
		expect(streamingNode?.data.status).toBe("running");
		expect(streamingNode?.data.label).toBe("(thinking…)");
	});
});

describe("deriveGraph: subagent fan-out", () => {
	it("parallel mode fans out agent siblings with internal tool nodes", () => {
		const state = foldAll(researchScenario());
		const graph = deriveGraph(state);

		// subagent-call node
		expect(node(graph, "subagent:tc_sub")?.data.kind).toBe("subagent-call");
		expect(node(graph, "subagent:tc_sub")?.data.status).toBe("running");

		// two agent siblings
		const agentA = node(graph, "agent:tc_sub:0");
		const agentB = node(graph, "agent:tc_sub:1");
		expect(agentA?.data.label).toBe("调研A");
		expect(agentA?.data.status).toBe("running"); // exitCode -1
		expect(agentB?.data.label).toBe("调研B");

		// spawn edges from the call node
		expect(graph.edges.filter((e) => e.kind === "spawn").map((e) => e.target)).toEqual([
			"agent:tc_sub:0",
			"agent:tc_sub:1",
		]);

		// second-level tool node inside agent A's transcript
		const agentTool = node(graph, "agent:tc_sub:0:t0");
		expect(agentTool?.data.kind).toBe("agent-tool");
		expect(agentTool?.data.label).toBe("grep /deriveGraph/");
		expect(graph.edges.some((e) => e.source === "agent:tc_sub:0" && e.target === "agent:tc_sub:0:t0")).toBe(true);
	});

	it("updates statuses when the subagent call completes", () => {
		const events = researchScenario();
		const doneDetails = subagentDetails([
			{ agent: "调研A", exitCode: 0, stopReason: "stop" },
			{ agent: "调研B", exitCode: 1, stopReason: "error", errorMessage: "boom" },
		]);
		const state = foldAll([
			...events,
			{
				type: "tool_execution_end",
				toolCallId: "tc_sub",
				toolName: "subagent",
				result: { content: [], details: doneDetails },
				isError: false,
			},
		]);
		const graph = deriveGraph(state);
		expect(node(graph, "subagent:tc_sub")?.data.status).toBe("ok");
		expect(node(graph, "agent:tc_sub:0")?.data.status).toBe("ok");
		expect(node(graph, "agent:tc_sub:1")?.data.status).toBe("error");
	});

	it("chain mode connects results sequentially", () => {
		const details: SubagentDetails = {
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{ agent: "起草", agentSource: "user", task: "t1", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, step: 1 },
				{ agent: "润色", agentSource: "user", task: "t2", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, step: 2 },
			],
		};
		const state = foldAll([
			{ type: "message_start", message: assistantWithSubagentCall },
			{ type: "message_end", message: assistantWithSubagentCall },
			{ type: "tool_execution_start", toolCallId: "tc_sub", toolName: "subagent", args: {} },
			{
				type: "tool_execution_update",
				toolCallId: "tc_sub",
				toolName: "subagent",
				args: {},
				partialResult: { content: [], details },
			},
		]);
		const graph = deriveGraph(state);
		const spawnEdges = graph.edges.filter((e) => e.kind === "spawn");
		expect(spawnEdges.map((e) => `${e.source}->${e.target}`)).toEqual([
			"subagent:tc_sub->agent:tc_sub:0",
			"agent:tc_sub:0->agent:tc_sub:1",
		]);
		expect(node(graph, "agent:tc_sub:0")?.data.label).toBe("1. 起草");
	});

	it("single-mode streaming partial (exitCode 0, no stopReason) renders as running", () => {
		// Extension streams in-flight single results with exitCode 0 - only the
		// tool execution status tells us it's still running.
		const details: SubagentDetails = {
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{ agent: "调研员", agentSource: "user", task: "t", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
			],
		};
		const state = foldAll([
			{ type: "message_start", message: assistantWithSubagentCall },
			{ type: "message_end", message: assistantWithSubagentCall },
			{ type: "tool_execution_start", toolCallId: "tc_sub", toolName: "subagent", args: {} },
			{
				type: "tool_execution_update",
				toolCallId: "tc_sub",
				toolName: "subagent",
				args: {},
				partialResult: { content: [], details },
			},
		]);
		const graph = deriveGraph(state);
		expect(node(graph, "agent:tc_sub:0")?.data.status).toBe("running");

		// Once the tool ends with a settled stopReason, the same result is ok.
		const done = foldAll([
			...researchScenario(),
			{
				type: "tool_execution_end",
				toolCallId: "tc_sub",
				toolName: "subagent",
				result: {
					content: [],
					details: {
						...details,
						results: [{ ...details.results[0]!, exitCode: 0, stopReason: "stop" }],
					},
				},
				isError: false,
			},
		]);
		expect(node(deriveGraph(done), "agent:tc_sub:0")?.data.status).toBe("ok");
	});

	it("user messages emitted with start+end produce exactly one node and no duplicate edges", () => {
		const state = foldAll([
			{ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
		]);
		const graph = deriveGraph(state);
		const userNodes = graph.nodes.filter((n) => n.data.kind === "user");
		expect(userNodes).toHaveLength(1);
		const edgeIds = graph.edges.map((e) => e.id);
		expect(new Set(edgeIds).size).toBe(edgeIds.length);
	});
});

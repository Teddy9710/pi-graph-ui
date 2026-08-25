import { describe, expect, it } from "vitest";
import {
	buildChatTimeline,
	isOrchInjected,
	userText,
	type ChatItem,
} from "../src/chat.ts";
import {
	buildSynthPrompt,
	foldRunEvent,
	initRunState,
	ORCH_RESULTS_SENTINEL,
} from "../src/orchestration.ts";
import type { AssistantMessage, Message, UserMessage } from "../src/types.ts";

const TS = 1_700_000_000_000;

function userMsg(text: string, timestamp = TS): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantMsg(
	blocks: AssistantMessage["content"],
	timestamp = TS,
): AssistantMessage {
	return {
		role: "assistant",
		content: blocks,
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function text(t: string) {
	return { type: "text" as const, text: t };
}

function toolResultMsg(timestamp = TS): Message {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "read",
		content: [text("file body")],
		isError: false,
		timestamp,
	};
}

/** Fold a planned run (goal → running) to completion of the given phase. */
function plannedRun(status: "planning" | "running" = "running") {
	let state = initRunState();
	state = foldRunEvent(state, {
		type: "plan_started",
		runId: "run-1",
		goal: "调研一下",
		startedAt: TS + 10,
	});
	if (status === "running") {
		state = foldRunEvent(state, {
			type: "run_started",
			runId: "run-1",
			startedAt: TS + 20,
			graph: {
				nodes: [
					{ id: "a", task: "任务 A", label: "调研" },
					{ id: "b", task: "任务 B" },
				],
				edges: [{ id: "a->b", source: "a", target: "b" }],
			},
		});
	}
	return state;
}

describe("userText", () => {
	it("returns string content as-is", () => {
		expect(userText(userMsg("你好"))).toBe("你好");
	});

	it("joins text blocks and marks images", () => {
		const m: UserMessage = {
			role: "user",
			timestamp: TS,
			content: [text("看这张图"), { type: "image", data: "x", mimeType: "image/png" }],
		};
		expect(userText(m)).toBe("看这张图\n[图片]");
	});
});

describe("isOrchInjected", () => {
	it("matches the sentinel user message", () => {
		expect(isOrchInjected(userMsg(`${ORCH_RESULTS_SENTINEL}\n{}`))).toBe(true);
	});

	it("rejects normal user text, blocks, and other roles", () => {
		expect(isOrchInjected(userMsg("普通消息"))).toBe(false);
		const blocks: UserMessage = { role: "user", timestamp: TS, content: [text("块")] };
		expect(isOrchInjected(blocks)).toBe(false);
		expect(isOrchInjected(assistantMsg([text(`${ORCH_RESULTS_SENTINEL}`)]))).toBe(false);
	});
});

describe("buildChatTimeline", () => {
	it("returns [] for an empty idle session", () => {
		expect(buildChatTimeline([], initRunState(), null)).toEqual([]);
	});

	it("keeps transcript order and skips toolResult messages", () => {
		const messages: Message[] = [
			userMsg("第一句", TS + 1),
			assistantMsg([text("回复一")], TS + 2),
			toolResultMsg(TS + 3),
			userMsg("第二句", TS + 4),
		];
		const items = buildChatTimeline(messages, initRunState(), null);
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "user"]);
		expect(items[0]).toMatchObject({ text: "第一句" });
		expect(items[1]).toMatchObject({ text: "回复一" });
	});

	it("assistant items count toolCalls and flag thinking, joining only text blocks", () => {
		const messages: Message[] = [
			assistantMsg(
				[
					{ type: "thinking", thinking: "嗯…" },
					text("第一段"),
					{ type: "toolCall", id: "t1", name: "read", arguments: {} },
					text("第二段"),
				],
				TS,
			),
		];
		const [item] = buildChatTimeline(messages, initRunState(), null);
		expect(item).toMatchObject({ kind: "assistant", text: "第一段\n第二段", toolCalls: 1, hasThinking: true, streaming: false });
	});

	it("turns a sentinel message into an injected item with parsed meta", () => {
		const prompt = buildSynthPrompt("调研一下", "run-1", [{ nodeId: "a", label: "调研", text: "产出" }]);
		const items = buildChatTimeline([userMsg(prompt, TS)], initRunState(), null);
		expect(items).toHaveLength(1);
		const item = items[0] as Extract<ChatItem, { kind: "injected" }>;
		expect(item.kind).toBe("injected");
		expect(item.meta).toEqual({ runId: "run-1", goal: "调研一下", nodeCount: 1 });
		expect(item.raw).toBe(prompt);
	});

	it("detects BLOCK-wrapped sentinel messages (pi echoes prompts as [{type:'text',…}])", () => {
		const prompt = buildSynthPrompt("目标", "run-9", [{ nodeId: "a", text: "产出" }]);
		const blockWrapped: UserMessage = {
			role: "user",
			timestamp: TS,
			content: [{ type: "text", text: prompt }],
		};
		expect(isOrchInjected(blockWrapped)).toBe(true);
		const items = buildChatTimeline([blockWrapped], initRunState(), null);
		const item = items[0] as Extract<ChatItem, { kind: "injected" }>;
		expect(item.kind).toBe("injected");
		expect(item.meta?.nodeCount).toBe(1);
		expect(item.raw).toBe(prompt);
	});

	it("places the orch card after pre-run messages and before the injected results", () => {
		const prompt = buildSynthPrompt("调研一下", "run-1", [{ nodeId: "a", text: "产出" }]);
		const messages: Message[] = [
			userMsg("会话前的消息", TS), // same ms as the run — kind ranking decides
			userMsg(prompt, TS + 30), // injected after run_finished
			assistantMsg([text("整合后的回答")], TS + 31),
		];
		const run = plannedRun("running");
		run.finishedAt = TS + 25; // completed run keeps its card (retained state)
		const items = buildChatTimeline(messages, run, null);
		expect(items.map((i) => i.kind)).toEqual(["user", "orch", "injected", "assistant"]);
		const card = items[1] as Extract<ChatItem, { kind: "orch" }>;
		expect(card.timestamp).toBe(run.startedAt);
	});

	it("orders same-timestamp items by kind: user < orch < injected < assistant", () => {
		const prompt = buildSynthPrompt("g", "run-1", [{ nodeId: "a", text: "x" }]);
		const messages: Message[] = [
			assistantMsg([text("回答")], TS),
			userMsg(prompt, TS),
			userMsg("目标", TS),
		];
		const run = plannedRun("running");
		run.startedAt = TS;
		const items = buildChatTimeline(messages, run, null);
		expect(items.map((i) => i.kind)).toEqual(["user", "orch", "injected", "assistant"]);
	});

	it("shows the card while planning", () => {
		const items = buildChatTimeline([userMsg("目标", TS)], plannedRun("planning"), null);
		expect(items.map((i) => i.kind)).toEqual(["user", "orch"]);
	});

	it("no card for a manual editor run (goal null) or idle", () => {
		let editor = initRunState();
		editor = foldRunEvent(editor, {
			type: "run_started",
			runId: "run-2",
			startedAt: TS,
			graph: { nodes: [{ id: "a", task: "t" }], edges: [] },
		});
		expect(buildChatTimeline([userMsg("hi", TS)], editor, null).map((i) => i.kind)).toEqual(["user"]);
		expect(buildChatTimeline([userMsg("hi", TS)], initRunState(), null).map((i) => i.kind)).toEqual(["user"]);
	});

	it("appends the streaming draft last, flagged streaming", () => {
		const items = buildChatTimeline(
			[userMsg("目标", TS + 1)],
			initRunState(),
			assistantMsg([text("正在写…")], TS + 2),
		);
		expect(items).toHaveLength(2);
		expect(items[1]).toMatchObject({ kind: "assistant", text: "正在写…", streaming: true });
	});

	it("still parses meta out of a ~120KB injected payload", () => {
		const big = "产".repeat(60_000); // 3 bytes/char ≈ 180KB pre-truncation
		const prompt = buildSynthPrompt("目标", "run-1", [
			{ nodeId: "a", text: big },
			{ nodeId: "b", text: big },
		]);
		const items = buildChatTimeline([userMsg(prompt, TS)], initRunState(), null);
		const item = items[0] as Extract<ChatItem, { kind: "injected" }>;
		expect(item.meta?.nodeCount).toBe(2);
		// Section text is capped per node — the raw stays huge (bytes, not chars:
		// 产 is 3 bytes) yet line-2 JSON still parses.
		expect(Buffer.byteLength(item.raw, "utf8")).toBeGreaterThan(50_000);
	});
});

import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../src/event-hub.ts";
import { classifyLine } from "../src/pi-bridge.ts";
import type { JsonAgentSessionEvent } from "@pi-graph/shared";

describe("classifyLine", () => {
	it("classifies RpcResponse lines by type=response", () => {
		const line = '{"id":"1","type":"response","command":"get_state","success":true,"data":{}}';
		const result = classifyLine(line);
		expect(result?.kind).toBe("response");
		expect(result?.response?.command).toBe("get_state");
	});

	it("classifies event lines (all other objects)", () => {
		const line = '{"type":"agent_start"}';
		expect(classifyLine(line)?.kind).toBe("event");
	});

	it("ignores blank and non-JSON lines", () => {
		expect(classifyLine("")).toBeNull();
		expect(classifyLine("   ")).toBeNull();
		expect(classifyLine("not json")).toBeNull();
	});
});

describe("EventHub", () => {
	it("fans out events to subscribers and replays history", () => {
		const hub = new EventHub({ intervalMs: 1000 });
		const received: string[] = [];
		hub.subscribe((e) => received.push(e.type));
		hub.ingest({ type: "agent_start" });
		hub.ingest({ type: "turn_start" });
		expect(received).toEqual(["agent_start", "turn_start"]);
		const late: string[] = [];
		hub.subscribe((e) => late.push(e.type));
		expect(late).toEqual([]);
		expect(hub.history().map((e) => e.type)).toEqual(["agent_start", "turn_start"]);
	});

	it("coalesces rapid tool_execution_update for the same toolCallId", () => {
		vi.useFakeTimers();
		try {
			const hub = new EventHub({ intervalMs: 100 });
			const updates: number[] = [];
			hub.subscribe((e) => {
				if (e.type === "tool_execution_update") updates.push(e.partialResult.n);
			});
			const mk = (n: number): JsonAgentSessionEvent => ({
				type: "tool_execution_update",
				toolCallId: "tc",
				toolName: "subagent",
				args: {},
				partialResult: { n },
			});
			hub.ingest(mk(1)); // first passes immediately
			hub.ingest(mk(2)); // within interval -> withheld
			hub.ingest(mk(3)); // within interval -> replaces 2
			expect(updates).toEqual([1]);
			vi.advanceTimersByTime(120);
			expect(updates).toEqual([1, 3]); // latest flushed
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes a withheld update before tool_execution_end", () => {
		vi.useFakeTimers();
		try {
			const hub = new EventHub({ intervalMs: 1000 });
			const seq: string[] = [];
			hub.subscribe((e) => {
				if (e.type === "tool_execution_update") seq.push(`update:${e.partialResult.n}`);
				if (e.type === "tool_execution_end") seq.push("end");
			});
			hub.ingest({ type: "tool_execution_update", toolCallId: "tc", toolName: "t", args: {}, partialResult: { n: 1 } });
			hub.ingest({
				type: "tool_execution_end",
				toolCallId: "tc",
				toolName: "t",
				result: {},
				isError: false,
			});
			// The first update passed immediately (no timer pending), so end
			// follows without a redundant re-send.
			expect(seq).toEqual(["update:1", "end"]);
			expect(hub.history()).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("load() replaces history WITHOUT fanning out to subscribers", () => {
		const hub = new EventHub({ intervalMs: 1000 });
		hub.ingest({ type: "agent_start" });
		const seen: string[] = [];
		hub.subscribe((e) => seen.push(e.type));
		// The switch_session path: rebuild the replay buffer from the archive,
		// then ONE hello tells the clients — N event broadcasts would be a
		// storm the hello immediately overwrites.
		hub.load([{ type: "turn_start" }, { type: "agent_settled" }] as JsonAgentSessionEvent[]);
		expect(seen).toEqual([]);
		expect(hub.history().map((e) => e.type)).toEqual(["turn_start", "agent_settled"]);
	});

	it("load() leaves throttle state untouched — the next update passes immediately", () => {
		vi.useFakeTimers();
		try {
			const hub = new EventHub({ intervalMs: 1000 });
			hub.ingest({ type: "tool_execution_update", toolCallId: "tc", toolName: "t", args: {}, partialResult: { n: 1 } });
			hub.clear();
			hub.load([]);
			const seen: number[] = [];
			hub.subscribe((e) => {
				if (e.type === "tool_execution_update") seen.push(e.partialResult.n);
			});
			// A fresh toolCallId after a switch must not inherit stale pacing.
			hub.ingest({ type: "tool_execution_update", toolCallId: "tc2", toolName: "t", args: {}, partialResult: { n: 9 } });
			expect(seen).toEqual([9]);
		} finally {
			vi.useRealTimers();
		}
	});
});

import { describe, expect, it } from "vitest";
import {
	assemblePrompt,
	edgeId,
	finalOutput,
	foldRunEvent,
	initRunState,
	validateGraph,
	type GraphDef,
	type RunEvent,
} from "../src/orchestration.ts";
import { initState } from "../src/fold.ts";
import type { AssistantMessage } from "../src/types.ts";

function graph(over: Partial<GraphDef> = {}): GraphDef {
	return {
		nodes: [
			{ id: "a", task: "任务 A" },
			{ id: "b", task: "任务 B" },
		],
		edges: [{ id: "a->b", source: "a", target: "b" }],
		...over,
	};
}

describe("validateGraph", () => {
	it("accepts a valid DAG", () => {
		expect(validateGraph(graph())).toEqual([]);
	});

	it("rejects an empty node list", () => {
		expect(validateGraph({ nodes: [], edges: [] })[0]?.message).toContain("没有节点");
	});

	it("is total on malformed input (never throws)", () => {
		// The graph arrives as arbitrary JSON over the WS trust boundary.
		expect(validateGraph(undefined as never).length).toBeGreaterThan(0);
		expect(validateGraph(null as never).length).toBeGreaterThan(0);
		expect(validateGraph(42 as never).length).toBeGreaterThan(0);
		expect(validateGraph({ nodes: "x" } as never).length).toBeGreaterThan(0);
		expect(
			validateGraph({ nodes: [{ id: "a", task: "t" }, 7] as never, edges: [{ source: "a", target: "a" }] as never })
				.length,
		).toBeGreaterThan(0);
	});

	it("rejects duplicate node ids", () => {
		const issues = validateGraph({ nodes: [{ id: "a", task: "x" }, { id: "a", task: "y" }], edges: [] });
		expect(issues.some((i) => i.nodeOrEdge === "a" && i.message.includes("重复"))).toBe(true);
	});

	it("rejects invalid id characters", () => {
		const issues = validateGraph({ nodes: [{ id: "a b", task: "x" }], edges: [] });
		expect(issues[0]?.nodeOrEdge).toBe("a b");
	});

	it("rejects an empty task", () => {
		const issues = validateGraph({ nodes: [{ id: "a", task: "  " }], edges: [] });
		expect(issues.some((i) => i.message.includes("为空"))).toBe(true);
	});

	it("rejects model ids with cmd.exe metacharacters (argv injection)", () => {
		// --model passes through a cmd.exe shim where & | ^ " etc. execute.
		for (const bad of ["deepseek/chat & calc", 'x"|whoami', "a^b", "m(n)", "p%PATH%"]) {
			const issues = validateGraph({ nodes: [{ id: "a", task: "t", model: bad }], edges: [] });
			expect(issues.some((i) => i.message.includes("model"))).toBe(true);
		}
		const okIssues = validateGraph({ nodes: [{ id: "a", task: "t", model: "deepseek/deepseek-chat" }], edges: [] });
		expect(okIssues.filter((i) => i.message.includes("model"))).toEqual([]);
	});

	it("rejects agent names that would traverse the agents dir", () => {
		for (const bad of ["../secrets", "a/b", "a\\b", "x y"]) {
			const issues = validateGraph({ nodes: [{ id: "a", task: "t", agent: bad }], edges: [] });
			expect(issues.some((i) => i.message.includes("agent"))).toBe(true);
		}
	});

	it("rejects a dangling edge endpoint", () => {
		const issues = validateGraph({ nodes: [{ id: "a", task: "x" }], edges: [{ id: "a->zz", source: "a", target: "zz" }] });
		expect(issues.some((i) => i.message.includes("不存在"))).toBe(true);
	});

	it("rejects a self-loop", () => {
		const issues = validateGraph({ nodes: [{ id: "a", task: "x" }], edges: [{ id: "a->a", source: "a", target: "a" }] });
		expect(issues.some((i) => i.message.includes("自环"))).toBe(true);
	});

	it("rejects a duplicate edge", () => {
		const e = { id: "a->b", source: "a", target: "b" };
		const issues = validateGraph({ nodes: [{ id: "a", task: "x" }, { id: "b", task: "y" }], edges: [e, { ...e }] });
		expect(issues.some((i) => i.message.includes("边重复"))).toBe(true);
	});

	it("rejects a cycle and names the nodes on it", () => {
		const cyc: GraphDef = {
			nodes: [
				{ id: "a", task: "x" },
				{ id: "b", task: "y" },
				{ id: "c", task: "z" },
			],
			edges: [
				{ id: "a->b", source: "a", target: "b" },
				{ id: "b->a", source: "b", target: "a" },
			],
		};
		const issues = validateGraph(cyc);
		const cycle = issues.find((i) => i.message.includes("环"));
		expect(cycle).toBeDefined();
		expect(cycle?.nodeOrEdge).toContain("a");
		expect(cycle?.nodeOrEdge).toContain("b");
		expect(cycle?.nodeOrEdge).not.toContain("c");
	});
});

describe("assemblePrompt", () => {
	it("returns the bare task with no upstreams", () => {
		expect(assemblePrompt({ id: "a", task: "只做这件事" }, [])).toBe("只做这件事");
	});

	it("appends upstream outputs under headers", () => {
		const out = assemblePrompt({ id: "b", task: "汇总" }, [
			{ nodeId: "a1", text: "结论一" },
			{ nodeId: "a2", text: "结论二" },
		]);
		expect(out).toContain("汇总");
		expect(out).toContain("## 上游输入");
		expect(out).toContain("### from a1\n结论一");
		expect(out).toContain("### from a2\n结论二");
		// Deterministic: input order preserved.
		expect(out.indexOf("a1")).toBeLessThan(out.indexOf("a2"));
	});

	it("caps each upstream output at 50KB with an omission note", () => {
		const big = "x".repeat(60 * 1024);
		const out = assemblePrompt({ id: "b", task: "t" }, [{ nodeId: "a", text: big }]);
		expect(out.length).toBeLessThan(60 * 1024);
		expect(out).toContain("已截断");
	});
});

describe("finalOutput", () => {
	const msg = (content: AssistantMessage["content"], i: number): AssistantMessage =>
		({
			role: "assistant",
			content,
			api: "anthropic",
			provider: "anthropic",
			model: "m",
			usage: null as never,
			stopReason: "stop",
			timestamp: 1000 + i,
		}) as AssistantMessage;

	it("returns the last assistant text", () => {
		const s = initState();
		s.messages.push(msg([{ type: "text", text: "第一轮" }], 0), { role: "user", content: "u", timestamp: 1 } as never);
		s.messages.push(msg([{ type: "text", text: "最终回复" }], 2));
		expect(finalOutput(s)).toBe("最终回复");
	});

	it("skips thinking and toolCall blocks", () => {
		const s = initState();
		s.messages.push(
			msg([{ type: "thinking", thinking: "内心" }, { type: "text", text: "可见" }, { type: "toolCall", id: "t", name: "bash", arguments: {} }], 0),
		);
		expect(finalOutput(s)).toBe("可见");
	});

	it("returns empty string for an empty state", () => {
		expect(finalOutput(initState())).toBe("");
	});
});

describe("foldRunEvent", () => {
	const started: RunEvent = {
		type: "run_started",
		runId: "r1",
		startedAt: 1,
		graph: graph(),
	};

	it("run_started initializes all nodes pending", () => {
		const s = foldRunEvent(initRunState(), started);
		expect(s.runId).toBe("r1");
		expect(s.status).toBe("running");
		expect(Object.keys(s.nodes).sort()).toEqual(["a", "b"]);
		expect(Object.values(s.nodes).every((n) => n.status === "pending")).toBe(true);
	});

	it("node lifecycle running → ok records output and usage", () => {
		const s = initRunState();
		foldRunEvent(s, started);
		foldRunEvent(s, { type: "node_started", runId: "r1", nodeId: "a", startedAt: 5, assembledPrompt: "任务 A" });
		foldRunEvent(s, { type: "node_delta", runId: "r1", nodeId: "a", kind: "text", delta: "正在…" });
		foldRunEvent(s, {
			type: "node_completed",
			runId: "r1",
			nodeId: "a",
			endedAt: 9,
			durationMs: 4,
			output: { text: "A 的结果", stopReason: "stop", model: "deepseek/deepseek-chat", usage: { input: 1, output: 2, totalTokens: 3, cost: 0.01 } },
		});
		expect(s.nodes.a?.status).toBe("ok");
		expect(s.nodes.a?.output).toBe("A 的结果");
		expect(s.nodes.a?.usage?.totalTokens).toBe(3);
		expect(s.nodes.a?.preview).toBe("正在…");
	});

	it("node_failed and node_skipped record reason", () => {
		const s = initRunState();
		foldRunEvent(s, started);
		foldRunEvent(s, { type: "node_failed", runId: "r1", nodeId: "a", endedAt: 9, durationMs: 8, error: "exit 1" });
		foldRunEvent(s, { type: "node_skipped", runId: "r1", nodeId: "b", reason: "upstream failed: a" });
		expect(s.nodes.a?.status).toBe("error");
		expect(s.nodes.a?.error).toBe("exit 1");
		expect(s.nodes.b?.status).toBe("skipped");
		expect(s.nodes.b?.skipReason).toBe("upstream failed: a");
	});

	it("run_finished sets counts, aggregate usage and status", () => {
		const s = initRunState();
		foldRunEvent(s, started);
		foldRunEvent(s, {
			type: "run_finished",
			runId: "r1",
			finishedAt: 99,
			status: "completed",
			ok: 2,
			failed: 0,
			skipped: 0,
			usage: { input: 10, output: 20, totalTokens: 30, cost: 0.5 },
		});
		expect(s.status).toBe("completed");
		expect(s.ok).toBe(2);
		expect(s.usage.cost).toBeCloseTo(0.5);
	});

	it("ignores events from a stale runId", () => {
		const s = initRunState();
		foldRunEvent(s, started);
		const before = JSON.stringify(s.nodes);
		foldRunEvent(s, { type: "node_started", runId: "r-OTHER", nodeId: "a", startedAt: 5, assembledPrompt: "" });
		expect(JSON.stringify(s.nodes)).toBe(before);
	});

	it("a new run_started resets the state (live connection across runs)", () => {
		const s = initRunState();
		foldRunEvent(s, started);
		foldRunEvent(s, {
			type: "node_completed",
			runId: "r1",
			nodeId: "a",
			endedAt: 9,
			durationMs: 4,
			output: { text: "旧输出", stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 5, cost: 0 } },
		});
		const second: RunEvent = {
			type: "run_started",
			runId: "r2",
			startedAt: 100,
			graph: { nodes: [{ id: "x", task: "新图" }], edges: [] },
		};
		foldRunEvent(s, second);
		expect(s.runId).toBe("r2");
		expect(s.status).toBe("running");
		expect(Object.keys(s.nodes)).toEqual(["x"]); // old nodes dropped
		expect(s.nodes.a).toBeUndefined();
		expect(s.ok).toBe(0);
	});

	it("ignores unknown nodeId deltas", () => {
		const s = initRunState();
		foldRunEvent(s, started);
		foldRunEvent(s, { type: "node_delta", runId: "r1", nodeId: "ghost", kind: "text", delta: "?" });
		expect(s.nodes.ghost).toBeUndefined();
	});
});

describe("edgeId", () => {
	it("joins source and target with ->", () => {
		expect(edgeId("a", "b")).toBe("a->b");
	});
});

import { describe, expect, it } from "vitest";
import { emptyUsage, type AssistantMessage, type JsonAgentSessionEvent } from "@pi-graph/shared";
import {
	buildPlanPrompt,
	extractGraph,
	MAX_PLAN_NODES,
	PiPlanner,
	type PlanOutcome,
	type PlannerBridge,
} from "../src/planner.ts";

// ============================================================================
// extractGraph (pure)
// ============================================================================

describe("extractGraph", () => {
	it("extracts JSON wrapped in prose", () => {
		const out = extractGraph('好的，以下是规划：\n{"nodes":[{"id":"n1","task":"a"}],"edges":[]}\n希望有帮助！');
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.graph.nodes).toHaveLength(1);
			expect(out.graph.nodes[0]!.task).toBe("a");
		}
	});

	it("extracts JSON from a markdown fenced block", () => {
		const out = extractGraph('```json\n{"nodes":[{"id":"n1","task":"a"},{"id":"n2","task":"b"}],"edges":[{"source":"n1","target":"n2"}]}\n```');
		expect(out.ok).toBe(true);
	});

	it("rejects text without a JSON object", () => {
		const out = extractGraph("抱歉，我无法完成这个规划。");
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("JSON");
	});

	it("rejects unparseable JSON", () => {
		const out = extractGraph('{"nodes":[,,,}');
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("解析失败");
	});

	it("rejects parsed JSON that is not a graph shape", () => {
		const out = extractGraph('{"说明": "这不是图"}');
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("图结构");
	});

	it(`rejects more than ${MAX_PLAN_NODES} nodes`, () => {
		const nodes = Array.from({ length: MAX_PLAN_NODES + 1 }, (_, i) => ({ id: `n${i}`, task: "t" }));
		const out = extractGraph(JSON.stringify({ nodes, edges: [] }));
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("超过上限");
	});

	it("caps generated string sizes (planner output is untrusted)", () => {
		const out = extractGraph(
			JSON.stringify({
				nodes: [{ id: "n".repeat(200), task: "长".repeat(20_000), label: "标".repeat(500) }],
				edges: [],
			}),
		);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.graph.nodes[0]!.id!.length).toBeLessThanOrEqual(64);
			expect(out.graph.nodes[0]!.task!.length).toBeLessThanOrEqual(8000);
			expect(out.graph.nodes[0]!.label!.length).toBeLessThanOrEqual(100);
		}
		const edges = Array.from({ length: 600 }, () => ({ source: "x", target: "y" }));
		const badEdges = extractGraph(JSON.stringify({ nodes: [{ id: "a", task: "t" }], edges }));
		expect(badEdges.ok).toBe(false);
		if (!badEdges.ok) expect(badEdges.error).toContain("边数");
	});

	it("synthesizes edge ids and strips unknown node fields", () => {
		const out = extractGraph(
			JSON.stringify({
				nodes: [{ id: "n1", label: "研究", task: "查资料", position: { x: 1 }, bogus: "x", model: "  ", agent: "" }],
				edges: [{ source: "n1", target: "n2" }],
			}),
		);
		// n2 missing → invalid graph; but normalization itself is what we assert
		// via a valid variant below. This one must fail validation by rule.
		expect(out.ok).toBe(false);
		const good = extractGraph(
			JSON.stringify({
				nodes: [
					{ id: "n1", label: "研究", task: "查资料", position: { x: 1 }, bogus: "x", model: "  ", agent: "" },
					{ id: "n2", task: "汇总" },
				],
				edges: [{ source: "n1", target: "n2" }],
			}),
		);
		expect(good.ok).toBe(true);
		if (good.ok) {
			expect(good.graph.nodes[0]).toEqual({ id: "n1", label: "研究", task: "查资料" });
			expect(good.graph.edges[0]).toEqual({ id: "n1->n2", source: "n1", target: "n2" });
		}
	});

	it("surfaces validation issues (cycle, empty task, bad model)", () => {
		const cycle = extractGraph(
			JSON.stringify({
				nodes: [
					{ id: "n1", task: "a" },
					{ id: "n2", task: "b" },
				],
				edges: [
					{ source: "n1", target: "n2" },
					{ source: "n2", target: "n1" },
				],
			}),
		);
		expect(cycle.ok).toBe(false);
		if (!cycle.ok) expect(cycle.error).toContain("图校验未通过");

		const emptyTask = extractGraph(JSON.stringify({ nodes: [{ id: "n1", task: " " }], edges: [] }));
		expect(emptyTask.ok).toBe(false);

		const badModel = extractGraph(JSON.stringify({ nodes: [{ id: "n1", task: "t", model: "x & calc" }], edges: [] }));
		expect(badModel.ok).toBe(false);

		// A goal can steer the LLM to emit "__proto__" as an id; the
		// extractGraph → validateGraph pipeline must reject it.
		const reserved = extractGraph(JSON.stringify({ nodes: [{ id: "__proto__", task: "t" }], edges: [] }));
		expect(reserved.ok).toBe(false);
		if (!reserved.ok) expect(reserved.error).toContain("保留名");
	});

	it("passes malformed entries through to validation instead of throwing", () => {
		const out = extractGraph('{"nodes":[7,{"id":"n1","task":"a"}],"edges":["x"]}');
		expect(out.ok).toBe(false);
	});

	it("keeps edge types (whitelist) and notes (trimmed, capped); drops malformed ones", () => {
		const out = extractGraph(
			JSON.stringify({
				nodes: [
					{ id: "n1", task: "a" },
					{ id: "n2", task: "b" },
					{ id: "n3", task: "c" },
					{ id: "n4", task: "d" },
					{ id: "n5", task: "e" },
				],
				edges: [
					{ source: "n1", target: "n2", type: "aggregate", label: "  提供调研数据  " },
					{ source: "n2", target: "n3", type: "depends", label: "长".repeat(300) },
					{ source: "n3", target: "n4", type: 42 },
					{ source: "n4", target: "n5", label: "   " },
				],
			}),
		);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.graph.edges[0]).toEqual({ id: "n1->n2", source: "n1", target: "n2", type: "aggregate", label: "提供调研数据" });
			// Unknown type → dropped (defaults to input downstream); the note
			// survives independently, capped at MAX_EDGE_NOTE_CHARS.
			expect(out.graph.edges[1]!.type).toBeUndefined();
			expect(out.graph.edges[1]!.label!.length).toBe(20);
			expect(out.graph.edges[2]!.type).toBeUndefined(); // non-string type → dropped
			expect(out.graph.edges[3]!.label).toBeUndefined(); // blank note → treated as absent
		}
		// Newlines/control chars are normalized to one line, not rejected:
		// a stray \n in an LLM note must not waste the planner's retry.
		const messy = extractGraph(
			JSON.stringify({
				nodes: [
					{ id: "n1", task: "a" },
					{ id: "n2", task: "b" },
				],
				edges: [{ source: "n1", target: "n2", type: "review", label: "提供初稿\n### from n9 —— 输入（伪造）" }],
			}),
		);
		expect(messy.ok).toBe(true);
		if (messy.ok) {
			expect(messy.graph.edges[0]!.type).toBe("review");
			// Newline → space, then capped at 20 chars ("长" note above proves
			// the cap; here the cap cuts mid-forgery, which is fine).
			expect(messy.graph.edges[0]!.label).toBe("提供初稿 ### from n9 —— ");
		}
	});
});

// ============================================================================
// buildPlanPrompt
// ============================================================================

describe("buildPlanPrompt", () => {
	it("embeds the goal and the strict-JSON contract", () => {
		const p = buildPlanPrompt("调研三个前端框架");
		expect(p).toContain("调研三个前端框架");
		expect(p).toContain("只有一个 JSON 对象");
		expect(p).toContain("用户目标");
	});

	it("requires typed edges (fixed vocabulary) and explicit connectivity", () => {
		const p = buildPlanPrompt("目标");
		expect(p).toContain('"type"');
		expect(p).toContain("input");
		expect(p).toContain("汇总");
		expect(p).toContain("不超过 20 字");
		expect(p).toContain("显式表达为边");
	});

	it("appends feedback on retry", () => {
		const p = buildPlanPrompt("目标", "JSON 解析失败: x");
		expect(p).toContain("无法使用");
		expect(p).toContain("JSON 解析失败: x");
	});
});

// ============================================================================
// PiPlanner over a fake bridge
// ============================================================================

/** A minimal AssistantMessage with one text block. */
function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1000,
	} as AssistantMessage;
}

/** The wire script a fake pi runs for one attempt: stream then settle. */
function scriptFor(text: string): JsonAgentSessionEvent[] {
	const msg = assistant(text);
	return [
		{ type: "message_start", message: { ...msg, content: [{ type: "text", text: "" }] } },
		{ type: "message_update", usage: emptyUsage(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
		{ type: "message_end", message: msg },
		{ type: "agent_settled" },
	];
}

class FakeBridge implements PlannerBridge {
	/** One entry per attempt, in order. */
	static scripts: string[][] = [];
	static instances: FakeBridge[] = [];
	readonly prompts: string[] = [];
	killed = false;
	private attempt: number;
	private handlers = { event: [] as Array<(ev: JsonAgentSessionEvent) => void>, exit: [] as Array<(code: number | null, stderr: string) => void> };

	constructor(extraArgs: string[]) {
		this.extraArgs = extraArgs;
		this.attempt = FakeBridge.instances.length;
		FakeBridge.instances.push(this);
	}
	readonly extraArgs: string[];

	on(event: "event", fn: (ev: JsonAgentSessionEvent) => void): this;
	on(event: "exit", fn: (code: number | null, stderr: string) => void): this;
	on(event: "event" | "exit", fn: never): this;
	on(event: "event" | "exit", fn: unknown): this {
		(this.handlers as Record<string, unknown[]>)[event]!.push(fn);
		return this;
	}

	start(): void {
		/* events flow once the prompt arrives, like the real rpc mode */
	}

	async request(command: { type: "prompt"; message: string }): Promise<{ success: boolean; data?: unknown }> {
		this.prompts.push(command.message);
		const text = FakeBridge.scripts[this.attempt]?.shift();
		if (text !== undefined) {
			for (const ev of scriptFor(text)) {
				for (const fn of [...this.handlers.event]) fn(ev);
			}
		}
		return { success: true };
	}

	kill(): void {
		this.killed = true;
	}

	emitExit(code: number | null, stderr: string): void {
		for (const fn of [...this.handlers.exit]) fn(code, stderr);
	}
}

function freshPlanner(scripts: string[], timeoutMs = 60_000): PiPlanner {
	FakeBridge.scripts = scripts.map((s) => [s]);
	FakeBridge.instances = [];
	return new PiPlanner({
		model: "test/plan",
		timeoutMs,
		maxAttempts: 2,
		bridgeFactory: (args) => new FakeBridge(args),
	});
}

describe("PiPlanner", () => {
	it("streams deltas and returns a validated graph", async () => {
		const planner = freshPlanner(['{"nodes":[{"id":"n1","task":"a"},{"id":"n2","task":"b"}],"edges":[{"source":"n1","target":"n2"}]}']);
		const deltas: string[] = [];
		const out = await planner.plan("写一篇报告", { onDelta: (d) => deltas.push(d), signal: new AbortController().signal });
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.graph.nodes).toHaveLength(2);
		expect(deltas.join("")).toContain('"nodes"');
		const bridge = FakeBridge.instances[0]!;
		expect(bridge.extraArgs).toEqual(["--model", "test/plan"]);
		expect(bridge.prompts[0]).toContain("写一篇报告");
	});

	it("retries once with the validation error fed back", async () => {
		const planner = freshPlanner(["这不是 JSON", '{"nodes":[{"id":"n1","task":"a"}],"edges":[]}']);
		const deltas: string[] = [];
		const out = await planner.plan("目标", { onDelta: (d) => deltas.push(d), signal: new AbortController().signal });
		expect(out.ok).toBe(true);
		const second = FakeBridge.instances[1]!;
		expect(second).toBeDefined();
		expect(second.prompts[0]).toContain("无法使用");
		expect(second.prompts[0]).toContain("JSON");
		// The retry marker is visible in the stream preview.
		expect(deltas.join("")).toContain("重试");
	});

	it("fails after exhausting retries", async () => {
		const planner = freshPlanner(["还是不是 JSON", "依然不是"]);
		const out = await planner.plan("目标", { onDelta: () => {}, signal: new AbortController().signal });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("JSON");
	});

	it("reports a bridge exit as a process failure (no retry)", async () => {
		FakeBridge.scripts = [[]];
		FakeBridge.instances = [];
		const planner = new PiPlanner({
			model: "test/plan",
			maxAttempts: 2,
			bridgeFactory: () => {
				const b = new FakeBridge([]);
				// Exit right after start — before any prompt round-trip.
				const origStart = b.start.bind(b);
				b.start = () => {
					origStart();
					b.emitExit(1, "boom");
				};
				return b;
			},
		});
		const out = await planner.plan("目标", { onDelta: () => {}, signal: new AbortController().signal });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("规划进程退出");
		expect(FakeBridge.instances).toHaveLength(1); // process failure → no retry
	});

	it("aborts: resolves 已中止 and kills the bridge", async () => {
		const planner = freshPlanner([]); // never settles
		const abort = new AbortController();
		const promise = planner.plan("目标", { onDelta: () => {}, signal: abort.signal });
		await Promise.resolve(); // let askOnce register listeners + start
		abort.abort();
		const out = await promise;
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toBe("已中止");
		expect(FakeBridge.instances[0]!.killed).toBe(true);
	});

	it("times out an attempt that never settles", async () => {
		const planner = freshPlanner([], 5);
		const out = await planner.plan("目标", { onDelta: () => {}, signal: new AbortController().signal });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("规划超时");
		expect(FakeBridge.instances[0]!.killed).toBe(true);
	}, 10_000);

	it("rejects an empty goal and a metacharacter model without spawning", async () => {
		const planner = new PiPlanner({
			model: "bad & model",
			bridgeFactory: (args) => new FakeBridge(args),
		});
		FakeBridge.instances = [];
		const empty = await planner.plan("   ", { onDelta: () => {}, signal: new AbortController().signal });
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error).toContain("目标不能为空");

		const badModel = await planner.plan("目标", { onDelta: () => {}, signal: new AbortController().signal });
		expect(badModel.ok).toBe(false);
		if (!badModel.ok) expect(badModel.error).toContain("非法字符");
		expect(FakeBridge.instances).toHaveLength(0);
	});

	it("satisfies the Planner contract RunManager drives (type-level)", async () => {
		const outcome: PlanOutcome = { ok: true, graph: { nodes: [], edges: [] } };
		expect(outcome.ok).toBe(true);
	});
});

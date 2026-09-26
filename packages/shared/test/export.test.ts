import { describe, expect, it } from "vitest";
import {
	buildRunExport,
	exportGraphToJson,
	formatImportIssues,
	parseGraphJson,
	sanitizeFilename,
	type GraphDef,
} from "../src/export.ts";
import { foldRunEvent, initRunState, validateGraph } from "../src/orchestration.ts";

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

describe("exportGraphToJson", () => {
	it("pretty-prints a graph and round-trips through JSON", () => {
		const g = graph({ name: "g1" });
		const json = exportGraphToJson(g);
		expect(json).toContain('"name": "g1"');
		expect(JSON.parse(json)).toEqual(g);
	});
});

describe("parseGraphJson", () => {
	it("returns a graph for valid JSON", () => {
		const g = graph();
		expect(parseGraphJson(JSON.stringify(g))).toEqual({ graph: g });
	});

	it("returns an error for malformed JSON", () => {
		expect(parseGraphJson("not json")).toHaveProperty("error");
	});

	it("returns an error for non-graph shapes", () => {
		expect(parseGraphJson(JSON.stringify({ nodes: "nope", edges: [] }))).toHaveProperty("error");
		expect(parseGraphJson(JSON.stringify({ foo: "bar" }))).toHaveProperty("error");
		// Empty arrays are structurally a graph; validation (not parse) rejects them.
		expect(parseGraphJson(JSON.stringify({ nodes: [], edges: [] }))).toHaveProperty("graph");
	});
});

describe("buildRunExport", () => {
	it("includes graph, node output, error, duration, and aggregate usage", () => {
		let run = initRunState();
		const g = graph();
		run = foldRunEvent(run, { type: "run_started", runId: "r1", startedAt: 1000, graph: g });
		run = foldRunEvent(run, { type: "node_started", runId: "r1", nodeId: "a", startedAt: 1200, assembledPrompt: "p" });
		run = foldRunEvent(run, {
			type: "node_completed",
			runId: "r1",
			nodeId: "a",
			endedAt: 1500,
			durationMs: 300,
			output: {
				text: "out a",
				stopReason: "end",
				model: "m",
				usage: { input: 10, output: 5, totalTokens: 15, cost: 0.001 },
			},
		});
		run = foldRunEvent(run, { type: "node_started", runId: "r1", nodeId: "b", startedAt: 1500, assembledPrompt: "p" });
		run = foldRunEvent(run, {
			type: "node_failed",
			runId: "r1",
			nodeId: "b",
			endedAt: 1800,
			durationMs: 300,
			error: "boom",
		});
		run = foldRunEvent(run, {
			type: "run_finished",
			runId: "r1",
			finishedAt: 2000,
			status: "failed",
			ok: 1,
			failed: 1,
			skipped: 0,
			usage: { input: 10, output: 5, totalTokens: 15, cost: 0.001 },
		});

		const exported = buildRunExport(run);
		expect(exported.runId).toBe("r1");
		expect(exported.graph).toEqual(g);
		expect(exported.nodes.map((n) => n.id)).toEqual(["a", "b"]);

		const a = exported.nodes.find((n) => n.id === "a")!;
		expect(a.status).toBe("ok");
		expect(a.output).toBe("out a");
		expect(a.durationMs).toBe(300);

		const b = exported.nodes.find((n) => n.id === "b")!;
		expect(b.status).toBe("error");
		expect(b.error).toBe("boom");
		expect(b.durationMs).toBe(300);

		expect(exported.usage.totalTokens).toBe(15);
	});
});

describe("formatImportIssues", () => {
	it("formats issues with and without ids", () => {
		const issues = [
			{ nodeOrEdge: "a", message: "任务 prompt 为空" },
			{ message: "图中没有节点" },
		];
		expect(formatImportIssues(issues)).toBe("a：任务 prompt 为空；图中没有节点");
	});
});

describe("sanitizeFilename", () => {
	it("removes unsafe characters and trims", () => {
		expect(sanitizeFilename("my/graph:name?")).toBe("my graph name");
		expect(sanitizeFilename("  \t\n  ")).toBe("untitled");
	});
});

describe("validateGraph (re-export)", () => {
	it("works when imported via export.ts", () => {
		const issues = validateGraph(graph());
		expect(issues).toEqual([]);
	});
});

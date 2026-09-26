import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	copyText,
	downloadJson,
	graphExportFilename,
	importGraphDef,
	readTextFile,
	runExportFilename,
} from "./export-utils.ts";

beforeEach(() => {
	vi.stubGlobal("URL", {
		createObjectURL: vi.fn(() => "blob:test-url"),
		revokeObjectURL: vi.fn(),
	});
	document.body.innerHTML = "";
});

describe("copyText", () => {
	it("writes text to navigator.clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		await copyText("hello");
		expect(writeText).toHaveBeenCalledWith("hello");
	});

	it("throws when clipboard is unavailable", async () => {
		vi.stubGlobal("navigator", {});
		await expect(copyText("hello")).rejects.toThrow("当前环境不支持剪贴板");
	});
});

describe("downloadJson", () => {
	it("creates a temporary anchor with download attribute and revokes object URL", () => {
		vi.useFakeTimers();
		const clickSpy = vi.fn();
		const anchor = document.createElement("a");
		anchor.click = clickSpy;
		const createElementSpy = vi.spyOn(document, "createElement").mockReturnValue(anchor);
		try {
			downloadJson('{"a":1}', "test.json");
			expect(createElementSpy).toHaveBeenCalledWith("a");
			expect(anchor.download).toBe("test.json");
			expect(anchor.href).toBe("blob:test-url");
			expect(clickSpy).toHaveBeenCalled();
			vi.runAllTimers();
			expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
		} finally {
			createElementSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("readTextFile", () => {
	it("reads a File as text", async () => {
		const file = new File(["graph json"], "g.json", { type: "application/json" });
		expect(await readTextFile(file)).toBe("graph json");
	});
});

describe("importGraphDef", () => {
	const validGraph = {
		nodes: [{ id: "a", task: "任务 A" }],
		edges: [],
	};

	it("imports a valid graph from JSON string", () => {
		const result = importGraphDef(JSON.stringify(validGraph));
		expect("graph" in result).toBe(true);
		if ("graph" in result) expect(result.issues).toEqual([]);
	});

	it("imports from an object", () => {
		const result = importGraphDef(validGraph);
		expect("graph" in result).toBe(true);
	});

	it("reports validation issues without returning an error", () => {
		const result = importGraphDef({ nodes: [{ id: "a", task: "" }], edges: [] });
		expect("graph" in result).toBe(true);
		if ("graph" in result) expect(result.issues.length).toBeGreaterThan(0);
	});

	it("returns an error for malformed JSON", () => {
		const result = importGraphDef("not json");
		expect("error" in result).toBe(true);
	});

	it("returns an error for invalid shapes", () => {
		expect("error" in importGraphDef({ nodes: "nope" })).toBe(true);
		expect("error" in importGraphDef(null)).toBe(true);
	});
});

describe("filenames", () => {
	const fixedDate = new Date("2024-05-01T12:34:56Z");

	it("graphExportFilename uses sanitized name and local timestamp", () => {
		const dateSpy = vi.spyOn(globalThis, "Date").mockImplementation(() => fixedDate);
		try {
			expect(graphExportFilename({ name: "my/graph", nodes: [], edges: [] })).toMatch(/^pigraph-my graph-\d{8}-\d{6}\.json$/);
		} finally {
			dateSpy.mockRestore();
		}
	});

	it("runExportFilename uses sanitized runId", () => {
		const dateSpy = vi.spyOn(globalThis, "Date").mockImplementation(() => fixedDate);
		try {
			expect(runExportFilename({ runId: "run:1", status: "completed", goal: null, startedAt: null, finishedAt: null, graph: null, nodes: [], usage: { input: 0, output: 0, totalTokens: 0, cost: 0 } })).toMatch(/^pigraph-run-run 1-\d{8}-\d{6}\.json$/);
		} finally {
			dateSpy.mockRestore();
		}
	});
});

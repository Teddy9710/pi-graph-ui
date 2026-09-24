import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatNodeOutput, nodeArtifactsDir, writeNodeOutput } from "../src/artifacts.ts";

const tempDirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nodeArtifactsDir", () => {
	it("joins root/runId/nodeId", () => {
		expect(nodeArtifactsDir(join("C:", "art"), "orch-abc-1", "n1")).toBe(join("C:", "art", "orch-abc-1", "n1"));
	});

	it("returns null for Windows reserved device node ids (case-insensitive)", () => {
		const root = join("C:", "art");
		for (const id of ["con", "CON", "NuL", "aux", "PRN", "com1", "COM9", "lpt8", "lpt9", "LPT9"]) {
			expect(nodeArtifactsDir(root, "orch-abc-1", id)).toBeNull();
		}
	});

	it("returns null for unsafe runIds and out-of-shape node ids", () => {
		const root = join("C:", "art");
		expect(nodeArtifactsDir(root, "../evil", "n1")).toBeNull();
		expect(nodeArtifactsDir(root, "", "n1")).toBeNull();
		expect(nodeArtifactsDir(root, "orch-abc-1", "")).toBeNull();
		expect(nodeArtifactsDir(root, "orch-abc-1", "x".repeat(65))).toBeNull();
	});
});

describe("formatNodeOutput", () => {
	it("writes only-present header lines, separator, verbatim body, trailing newline", () => {
		const body = formatNodeOutput("orch-abc-1", "n1", "line1\nline2", {
			label: "调研",
			model: "deepseek/deepseek-chat",
			endedAt: Date.UTC(2026, 8, 24, 8, 0, 0),
			durationMs: 45230,
			attempts: 2,
		});
		expect(body).toBe(
			[
				"runId: orch-abc-1",
				"nodeId: n1",
				"label: 调研",
				"model: deepseek/deepseek-chat",
				"endedAt: 2026-09-24T08:00:00.000Z",
				"durationMs: 45230",
				"attempts: 2",
				"",
				"---",
				"",
				"line1\nline2",
				"",
			].join("\n"),
		);
	});

	it("reused shape: fromRunId instead of model/timing", () => {
		const body = formatNodeOutput("orch-abc-2", "n1", "ok", { fromRunId: "orch-abc-1" });
		expect(body.startsWith("runId: orch-abc-2\nnodeId: n1\nfromRunId: orch-abc-1\n\n---\n\nok\n")).toBe(true);
		expect(body).not.toContain("model:");
	});
});

describe("writeNodeOutput", () => {
	it("creates nested dirs and writes the exact file", () => {
		const root = scratch();
		const dir = join(root, "orch-abc-1", "n1");
		expect(writeNodeOutput(dir, "正文", "orch-abc-1", "n1", { label: "L" })).toBe(true);
		const written = readFileSync(join(dir, "output.md"), "utf8");
		expect(written).toContain("runId: orch-abc-1");
		expect(written).toContain("label: L");
		expect(written.endsWith("\n\n---\n\n正文\n")).toBe(true);
	});

	it("returns false (does not throw) when a path segment is a regular file", () => {
		const root = scratch();
		writeFileSync(join(root, "blocker"), "x");
		const ok = writeNodeOutput(join(root, "blocker", "n1", "nested"), "正文", "orch-abc-1", "n1", {});
		expect(ok).toBe(false);
	});

	it("mkdir is idempotent across attempts of the same node", () => {
		const root = scratch();
		const dir = join(root, "orch-abc-1", "n1");
		mkdirSync(dir, { recursive: true });
		expect(writeNodeOutput(dir, "again", "orch-abc-1", "n1", {})).toBe(true);
		expect(existsSync(join(dir, "output.md"))).toBe(true);
	});
});

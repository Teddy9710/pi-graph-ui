import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage, type AssistantMessage, type JsonAgentSessionEvent, type NodeDef } from "@pi-graph/shared";
import { PiNodeExecutor, type ExecutorBridge } from "../src/pi-node-executor.ts";

// ============================================================================
// Fake bridge (same wire script pattern as planner.test.ts)
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

class FakeBridge implements ExecutorBridge {
	/** One entry per spawn, in order; each entry = texts for successive prompts. */
	static scripts: string[][] = [];
	static instances: FakeBridge[] = [];
	readonly prompts: string[] = [];
	killed = false;
	private spawnIndex: number;
	private handlers = {
		event: [] as Array<(ev: JsonAgentSessionEvent) => void>,
		exit: [] as Array<(code: number | null, stderr: string) => void>,
	};

	constructor(
		readonly opts: { extraArgs: string[]; cwd?: string },
	) {
		this.spawnIndex = FakeBridge.instances.length;
		FakeBridge.instances.push(this);
	}

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
		const text = FakeBridge.scripts[this.spawnIndex]?.shift();
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

const baseNode: NodeDef = { id: "n1", task: "只回答问题" };

function freshExecutor(scripts: string[][], options: Partial<ConstructorParameters<typeof PiNodeExecutor>[0]> = {}) {
	FakeBridge.scripts = scripts;
	FakeBridge.instances = [];
	return new PiNodeExecutor({
		defaultModel: "test/node",
		bridgeFactory: (opts) => new FakeBridge(opts),
		...options,
	});
}

const quietCtx = () => ({
	onDelta: (_kind: "text" | "tool", _delta: string) => {},
	signal: new AbortController().signal,
});

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

// ============================================================================
// Quality gate + salvage retry (互鉴改进 1+4)
// ============================================================================

describe("PiNodeExecutor quality gate / salvage", () => {
	it("gate off (default): a one-char answer passes with one spawn", async () => {
		const exec = freshExecutor([["5"]]);
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "1+4=?", upstream: [] }, quietCtx());
		expect(r.ok).toBe(true);
		expect(r.text).toBe("5");
		expect(r.attempts).toBeUndefined();
		expect(FakeBridge.instances).toHaveLength(1);
	});

	it("gate on, answer clears the threshold: no retry, no attempts flag", async () => {
		const exec = freshExecutor([["这是一个足够长的回答，远远超过二十个字符。"]], { minOutputChars: 20 });
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(true);
		expect(r.attempts).toBeUndefined();
		expect(FakeBridge.instances).toHaveLength(1);
	});

	it("violation salvages: re-runs with the ORIGINAL prompt, longer answer wins, attempts=2", async () => {
		const exec = freshExecutor([["5"], ["计算结果是 5，因为 2 加 3 等于 5。"]], { minOutputChars: 20 });
		const deltas: string[] = [];
		const r = await exec.run(
			{ node: { ...baseNode }, assembledPrompt: "原题 prompt", upstream: [] },
			{ onDelta: (_k, d) => deltas.push(d), signal: new AbortController().signal },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toBe("计算结果是 5，因为 2 加 3 等于 5。");
		expect(r.attempts).toBe(2);
		expect(FakeBridge.instances).toHaveLength(2);
		// 原题不改写：第二次收到的 prompt 与第一次完全一致。
		expect(FakeBridge.instances[1]!.prompts[0]).toBe("原题 prompt");
		expect(FakeBridge.instances[0]!.prompts[0]).toBe("原题 prompt");
		// The marker rides the delta stream (planner-retry style).
		expect(deltas.join("")).toContain("质量门");
		expect(deltas.join("")).toContain("重跑");
	});

	it("salvage keeps the first answer when the retry is shorter or empty", async () => {
		const exec = freshExecutor([["这是一个短回答"], [""]], { minOutputChars: 20 });
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(true);
		expect(r.text).toBe("这是一个短回答");
		expect(r.attempts).toBe(2);
		expect(FakeBridge.instances).toHaveLength(2);
	});

	it("both answers empty: the node fails loudly (never a silent empty success)", async () => {
		const exec = freshExecutor([[""], [""]], { minOutputChars: 20 });
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("两次输出均为空");
		expect(r.error).toContain("minOutputChars=20");
	});

	it("real failures are never salvaged (planner's process-failure rule)", async () => {
		FakeBridge.scripts = [[]];
		FakeBridge.instances = [];
		const exec = new PiNodeExecutor({
			defaultModel: "test/node",
			minOutputChars: 20,
			bridgeFactory: (opts) => {
				const b = new FakeBridge(opts);
				const origStart = b.start.bind(b);
				b.start = () => {
					origStart();
					b.emitExit(1, "boom");
				};
				return b;
			},
		});
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("pi 进程退出");
		expect(FakeBridge.instances).toHaveLength(1);
	});

	it("abort between attempts: no second spawn (中止后不重试)", async () => {
		const exec = freshExecutor([["5"]], { minOutputChars: 20 });
		const abort = new AbortController();
		const promise = exec.run(
			{ node: { ...baseNode }, assembledPrompt: "t", upstream: [] },
			{ onDelta: () => {}, signal: abort.signal },
		);
		// First attempt settles asynchronously; abort lands before the gate
		// continuation runs, so the salvage branch must bail out.
		abort.abort();
		const r = await promise;
		expect(r.ok).toBe(true);
		expect(r.text).toBe("5");
		expect(FakeBridge.instances).toHaveLength(1);
	});

	it("retry disabled: an empty output fails, a short non-empty one stands", async () => {
		const exec = freshExecutor([[""]], { minOutputChars: 20, salvageRetry: false });
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(false);
		expect(r.error).toContain("输出为空");
		expect(FakeBridge.instances).toHaveLength(1);

		const exec2 = freshExecutor([["短的"]], { minOutputChars: 20, salvageRetry: false });
		const r2 = await exec2.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r2.ok).toBe(true);
		expect(r2.text).toBe("短的");
		expect(FakeBridge.instances).toHaveLength(1);
	});

	it("node.minOutputChars overrides the executor default", async () => {
		const exec = freshExecutor([["12345"]], { minOutputChars: 100 });
		const r = await exec.run(
			{ node: { ...baseNode, minOutputChars: 3 }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(r.ok).toBe(true);
		expect(r.attempts).toBeUndefined(); // 5 chars ≥ 3 → passes the node-level gate
	});
});

// ============================================================================
// Node capability profile: timeoutMs / workdir / tools (互鉴改进 2+3)
// ============================================================================

describe("PiNodeExecutor capability profile", () => {
	it("node.timeoutMs overrides the executor budget", async () => {
		const exec = freshExecutor([[]], { timeoutMs: 60_000 }); // never settles
		const r = await exec.run(
			{ node: { ...baseNode, timeoutMs: 5 }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(r.ok).toBe(false);
		expect(r.error).toContain("节点超时");
		expect(r.error).toContain("5ms");
	}, 10_000);

	it("workdir: the bridge cwd moves under the base and the dir is created", async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-exec-test-"));
		tempDirs.push(base);
		const exec = freshExecutor([["回答内容足够长，没有任何问题。"]], { cwd: base });
		const r = await exec.run(
			{ node: { ...baseNode, workdir: "nodes/dev" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(r.ok).toBe(true);
		const bridge = FakeBridge.instances[0]!;
		expect(bridge.opts.cwd).toBe(join(base, "nodes", "dev"));
		expect(existsSync(join(base, "nodes", "dev"))).toBe(true);
	});

	it("workdir escaping the base is refused at the executor too (defense in depth)", async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-exec-test-"));
		tempDirs.push(base);
		const exec = freshExecutor([["ok"]], { cwd: base });
		const r = await exec.run(
			{ node: { ...baseNode, workdir: "../../elsewhere" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(r.ok).toBe(false);
		expect(r.error).toContain("越界");
		expect(FakeBridge.instances).toHaveLength(0); // refused before spawning
	});

	it("tools/excludeTools ride the argv as comma-joined flags", async () => {
		const exec = freshExecutor([["回答内容足够长，没有任何问题。"]]);
		await exec.run(
			{ node: { ...baseNode, tools: ["read", "grep"], excludeTools: ["bash"] }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		const args = FakeBridge.instances[0]!.opts.extraArgs;
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep");
		expect(args).toContain("--exclude-tools");
		expect(args[args.indexOf("--exclude-tools") + 1]).toBe("bash");
	});

	it("model and default model still resolve as before", async () => {
		const exec = freshExecutor([["回答内容足够长，没有任何问题。"], ["回答内容足够长，没有任何问题。"]]);
		await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(FakeBridge.instances[0]!.opts.extraArgs).toEqual(["--model", "test/node"]);

		await exec.run(
			{ node: { ...baseNode, model: "prov/m" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(FakeBridge.instances[1]!.opts.extraArgs).toEqual(["--model", "prov/m"]);
	});
});

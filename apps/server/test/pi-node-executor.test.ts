import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
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

	/** Inject a raw wire event (scripts only cover text streaming). */
	emitEvent(ev: JsonAgentSessionEvent): void {
		for (const fn of [...this.handlers.event]) fn(ev);
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

	it("salvage shares the node wall clock: budget spent → no second spawn (短答案原样放行)", async () => {
		// timeoutMs 小到首次 spawn 后剩余不足 1s：起不了有意义的重跑，
		// 短答案保留、不标 attempts——旧行为会给重跑再开一份完整计时器
		const exec = freshExecutor([["5"], ["计算结果是 5，因为 2 加 3 等于 5。"]], { minOutputChars: 20, timeoutMs: 100 });
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(true);
		expect(r.text).toBe("5");
		expect(r.attempts).toBeUndefined();
		expect(FakeBridge.instances).toHaveLength(1);
	});

	it("salvage retry times out at the ORIGINAL deadline (timer = remaining budget, not a fresh one)", async () => {
		// 首个 spawn 延迟 800ms 才给出短答案（剩余 ~1200ms）；重跑永不
		// settle → 重跑计时器在剩余预算处收束，节点随即按首次的短答案
		// 收尾（重跑失败不顶掉首次成功答案，salvage 语义不变）。关键回归
		// 点：总墙钟 ≈ timeoutMs，而不是旧行为的 2 ×（800 + 2000 = 2800ms）。
		FakeBridge.scripts = [["5"], []];
		FakeBridge.instances = [];
		let spawn = 0;
		const exec = new PiNodeExecutor({
			defaultModel: "test/node",
			minOutputChars: 20,
			timeoutMs: 2_000,
			bridgeFactory: (opts) => {
				const b = new FakeBridge(opts);
				const index = spawn++;
				const origRequest = b.request.bind(b);
				if (index === 0) {
					b.request = async (cmd) => {
						await new Promise((res) => setTimeout(res, 800));
						return origRequest(cmd);
					};
				}
				return b;
			},
		});
		const start = Date.now();
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		const elapsed = Date.now() - start;
		expect(r.ok).toBe(true);
		expect(r.text).toBe("5"); // 重跑超时不顶掉首次的成功答案
		expect(r.attempts).toBe(2);
		expect(FakeBridge.instances).toHaveLength(2); // 重跑确实发生，只是没再拿整份预算
		expect(elapsed).toBeLessThan(2_400); // ~800 + ~1200；旧代码这里是 ~2800
	}, 10_000);

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

// ============================================================================
// Failure classification (kind) — the engine's auto-retry keys on these:
// timeout/process/model are retryable, config/aborted/internal never are. A
// mis-classified site would either burn retry budget on a permanent error or
// skip retrying a transient one, so every failure site is pinned here.
// ============================================================================

describe("PiNodeExecutor failure classification (kind)", () => {
	it("config: bad model metacharacters / missing agent fail BEFORE spawning", async () => {
		const exec = freshExecutor([]);
		const badModel = await exec.run(
			{ node: { ...baseNode, model: "x & calc" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(badModel.ok).toBe(false);
		if (!badModel.ok) {
			expect(badModel.kind).toBe("config");
			expect(badModel.error).toContain("非法字符");
		}
		const missingAgent = await exec.run(
			{ node: { ...baseNode, agent: "no-such-persona" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(missingAgent.ok).toBe(false);
		if (!missingAgent.ok) {
			expect(missingAgent.kind).toBe("config");
			expect(missingAgent.error).toContain("未找到 agent");
		}
		expect(FakeBridge.instances).toHaveLength(0);
	});

	it("config: workdir escape and an un-creatable workdir (a file blocks the path)", async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-exec-test-"));
		tempDirs.push(base);
		writeFileSync(join(base, "blocker"), "x"); // mkdirSync would hit ENOTDIR/EEXIST
		const exec = freshExecutor([], { cwd: base });
		const escape = await exec.run(
			{ node: { ...baseNode, workdir: "../../elsewhere" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(escape.ok).toBe(false);
		if (!escape.ok) expect(escape.kind).toBe("config");
		const blocked = await exec.run(
			{ node: { ...baseNode, workdir: "blocker" }, assembledPrompt: "t", upstream: [] },
			quietCtx(),
		);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) {
			expect(blocked.kind).toBe("config");
			expect(blocked.error).toContain("创建失败");
		}
		expect(FakeBridge.instances).toHaveLength(0);
	});

	it("process: the pi process exits nonzero", async () => {
		FakeBridge.scripts = [[]];
		FakeBridge.instances = [];
		const exec = new PiNodeExecutor({
			defaultModel: "test/node",
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
		if (!r.ok) {
			expect(r.kind).toBe("process");
			expect(r.error).toContain("pi 进程退出");
		}
	});

	it("timeout: an attempt that never settles", async () => {
		const exec = freshExecutor([[]], { timeoutMs: 5 });
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.kind).toBe("timeout");
			expect(r.error).toContain("节点超时");
		}
	}, 10_000);

	it("model: agent_settled after a folded terminal error (stopReason=error)", async () => {
		FakeBridge.scripts = [[]];
		FakeBridge.instances = [];
		const exec = new PiNodeExecutor({
			defaultModel: "test/node",
			bridgeFactory: (opts) => {
				const b = new FakeBridge(opts);
				const origRequest = b.request.bind(b);
				b.request = async (cmd) => {
					const ok = await origRequest(cmd); // records the prompt
					const errored = { ...assistant(""), stopReason: "error", errorMessage: "quota exceeded" } as AssistantMessage;
					b.emitEvent({ type: "agent_end", messages: [errored] });
					b.emitEvent({ type: "agent_settled" });
					return ok;
				};
				return b;
			},
		});
		const r = await exec.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.kind).toBe("model");
			expect(r.error).toContain("quota exceeded");
		}
	});

	it("model: the rpc rejects the prompt (success:false) / process: the request throws", async () => {
		FakeBridge.scripts = [[]];
		FakeBridge.instances = [];
		const rejected = new PiNodeExecutor({
			defaultModel: "test/node",
			bridgeFactory: (opts) => {
				const b = new FakeBridge(opts);
				b.request = async () => ({ success: false, data: { reason: "nope" } });
				return b;
			},
		});
		const r1 = await rejected.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r1.ok).toBe(false);
		if (!r1.ok) {
			expect(r1.kind).toBe("model");
			expect(r1.error).toContain("prompt 被拒绝");
		}

		FakeBridge.scripts = [[]];
		FakeBridge.instances = [];
		const thrown = new PiNodeExecutor({
			defaultModel: "test/node",
			bridgeFactory: (opts) => {
				const b = new FakeBridge(opts);
				b.request = async () => {
					throw new Error("stdin broke");
				};
				return b;
			},
		});
		const r2 = await thrown.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r2.ok).toBe(false);
		if (!r2.ok) {
			expect(r2.kind).toBe("process");
			expect(r2.error).toContain("stdin broke");
		}
	});

	it("aborted: abort mid-attempt", async () => {
		const exec = freshExecutor([[]]); // never settles on its own
		const abort = new AbortController();
		const promise = exec.run(
			{ node: { ...baseNode }, assembledPrompt: "t", upstream: [] },
			{ onDelta: () => {}, signal: abort.signal },
		);
		await Promise.resolve(); // let runOnce register the listener + start
		abort.abort();
		const r = await promise;
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.kind).toBe("aborted");
			expect(r.error).toBe("已中止");
		}
	});

	it("model: quality-gate empty outputs (retry off / budget spent / both empty)", async () => {
		// Retry off, empty first answer.
		const off = freshExecutor([[""]], { minOutputChars: 20, salvageRetry: false });
		const r1 = await off.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r1.ok).toBe(false);
		if (!r1.ok) {
			expect(r1.kind).toBe("model");
			expect(r1.error).toContain("输出为空");
		}
		// Salvage on but the wall clock is spent.
		const spent = freshExecutor([[""]], { minOutputChars: 20, timeoutMs: 100 });
		const r2 = await spent.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r2.ok).toBe(false);
		if (!r2.ok) {
			expect(r2.kind).toBe("model");
			expect(r2.error).toContain("预算已用尽");
		}
		// Both salvage answers empty.
		const both = freshExecutor([[""], [""]], { minOutputChars: 20 });
		const r3 = await both.run({ node: { ...baseNode }, assembledPrompt: "t", upstream: [] }, quietCtx());
		expect(r3.ok).toBe(false);
		if (!r3.ok) {
			expect(r3.kind).toBe("model");
			expect(r3.error).toContain("两次输出均为空");
		}
	});
});

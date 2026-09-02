/**
 * PiNodeExecutor - production Executor: one pi rpc instance per node.
 *
 * Mirrors pi's own subagent fan-out pattern: `--no-session` in-memory
 * instance, persona body injected via a temp file + --append-system-prompt
 * (cmd.exe argv is capped at 8191 chars, so the TASK travels over stdin RPC,
 * never the command line). The node's event stream is folded locally with
 * the shared foldEvent; completion races agent_settled vs process exit vs
 * timeout, and the bridge is killed in every path (no orphaned trees).
 *
 * Node capability profile (节点档案, from the shared NodeDef — validateGraph
 * guarantees the shapes before they get here):
 * - timeoutMs / workdir / tools / excludeTools are applied per spawn;
 * - minOutputChars is a QUALITY GATE: a trimmed output shorter than the
 *   threshold is a violation. With salvageRetry on (default), the node is
 *   re-run ONCE with the original prompt unchanged and the LONGER of the two
 *   successful answers wins (pi-graph-tool's salvage semantics — one bad
 *   generation should not drop a node); two empty answers fail the node.
 *   Abort is never retried past. Violations surface as a marker delta plus
 *   attempts:2 on node_completed, not as silent completions.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";
import {
	finalOutput,
	foldEvent,
	initState,
	MODEL_RE,
	type AssistantMessage,
	type JsonAgentSessionEvent,
	type NodeUsage,
} from "@pi-graph/shared";
import { PiBridge } from "./pi-bridge.ts";
import type { Executor, ExecutorCall, NodeResult } from "./orchestrator.ts";

/** The PiBridge surface PiNodeExecutor uses — narrow so tests can stand in. */
export interface ExecutorBridge {
	on(event: "event", fn: (ev: JsonAgentSessionEvent) => void): unknown;
	on(event: "exit", fn: (code: number | null, stderr: string) => void): unknown;
	start(): void;
	request(command: { type: "prompt"; message: string }): Promise<{ success: boolean; data?: unknown }>;
	kill(): void;
}

export interface PiExecutorOptions {
	/** pi executable; defaults to PiBridge's own resolution (pi/pi.cmd). */
	bin?: string;
	cwd?: string;
	/** Model for nodes without one. */
	defaultModel?: string;
	/** Directory containing <name>.md agent personas. */
	agentsDir?: string;
	/** Per-node wall clock budget. Default 10 minutes. */
	timeoutMs?: number;
	/**
	 * Quality gate default (chars): trimmed outputs shorter than this are
	 * violations. Overridable per node via node.minOutputChars. Default 0
	 * disables the gate entirely (pre-profile behavior).
	 */
	minOutputChars?: number;
	/**
	 * Salvage retry on violations: re-run the node once with the original
	 * prompt, keep the longer successful answer. Default true. Env switch:
	 * ORCH_NODE_RETRY=0 turns it off (violations with an EMPTY output then
	 * fail the node outright).
	 */
	salvageRetry?: boolean;
	/** Test seam; default builds a real PiBridge. */
	bridgeFactory?: (opts: { extraArgs: string[]; cwd?: string }) => ExecutorBridge;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Strip YAML frontmatter; the persona is the markdown body. */
function personaBody(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function usageOf(state: ReturnType<typeof initState>): NodeUsage {
	const u = state.usageTotal;
	return { input: u.input, output: u.output, totalTokens: u.totalTokens, cost: u.cost?.total ?? 0 };
}

function lastAssistant(messages: ReturnType<typeof initState>["messages"]): AssistantMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant") return m as AssistantMessage;
	}
	return null;
}

export class PiNodeExecutor implements Executor {
	private readonly bin: string | undefined;
	private readonly cwd: string | undefined;
	private readonly defaultModel: string;
	private readonly agentsDir: string;
	private readonly timeoutMs: number;
	private readonly minOutputChars: number;
	private readonly salvageRetry: boolean;
	private readonly bridgeFactory: (opts: { extraArgs: string[]; cwd?: string }) => ExecutorBridge;

	constructor(options: PiExecutorOptions = {}) {
		this.bin = options.bin;
		this.cwd = options.cwd;
		this.defaultModel = options.defaultModel ?? "deepseek/deepseek-chat";
		this.agentsDir = options.agentsDir ?? resolvePath(homedir(), ".pi", "agent", "agents");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.minOutputChars = Math.max(0, Math.floor(options.minOutputChars ?? 0)) || 0;
		this.salvageRetry = options.salvageRetry !== false;
		this.bridgeFactory = options.bridgeFactory ?? ((opts) => new PiBridge({ bin: this.bin, cwd: opts.cwd, extraArgs: opts.extraArgs }));
	}

	async run(
		call: ExecutorCall,
		ctx: { onDelta: (kind: "text" | "tool", delta: string) => void; signal: AbortSignal },
	): Promise<NodeResult> {
		const minChars = call.node.minOutputChars ?? this.minOutputChars;
		if (minChars <= 0) return this.runOnce(call, ctx); // gate off — exactly the pre-profile behavior

		const first = await this.runOnce(call, ctx);
		if (!first.ok) return first; // real failures are never salvaged — same env, same outcome
		const len = first.text.trim().length;
		if (len >= minChars) return first;

		if (!this.salvageRetry) {
			// Gate on, retry off: only a truly EMPTY output escalates to failure;
			// a short-but-nonempty answer stands as-is.
			if (len === 0) return { ok: false, text: "", error: `输出为空（质量门 minOutputChars=${minChars}）` };
			return first;
		}
		if (ctx.signal.aborted) return first; // 中止后不重试

		// Salvage: one re-run with the ORIGINAL prompt (no rewriting), longer
		// successful answer wins. The marker rides the delta stream so the
		// preview shows why the node twitched (same pattern as the planner's
		// "第 N 次规划无效" notice).
		ctx.onDelta("text", `\n\n—— 输出仅 ${len} 字符（< 质量门 ${minChars}），用原题重跑一次 ——\n\n`);
		const second = await this.runOnce(call, ctx);
		const pick = second.ok && second.text.trim().length > len ? second : first;
		if (pick.text.trim().length === 0) {
			return { ok: false, text: "", error: `两次输出均为空（质量门 minOutputChars=${minChars}）` };
		}
		return { ...pick, attempts: 2 };
	}

	/** One pi rpc attempt: spawn → prompt over stdin → race settle/exit/timeout/abort. */
	private async runOnce(
		call: ExecutorCall,
		ctx: { onDelta: (kind: "text" | "tool", delta: string) => void; signal: AbortSignal },
	): Promise<NodeResult> {
		const { node, assembledPrompt } = call;

		// Argv safety net (validateGraph already rejects these): the model id
		// passes through a cmd.exe shim where metacharacters would be executed.
		if (node.model !== undefined && !MODEL_RE.test(node.model)) {
			return { ok: false, text: "", error: `model「${node.model}」含非法字符` };
		}

		// --- persona: resolve before spawning; missing agent fails fast ---
		let tempDir: string | null = null;
		if (node.agent) {
			let raw: string;
			try {
				raw = readFileSync(resolvePath(this.agentsDir, `${node.agent}.md`), "utf8");
			} catch {
				return { ok: false, text: "", error: `未找到 agent「${node.agent}」（查找目录 ${this.agentsDir}）` };
			}
			try {
				tempDir = mkdtempSync(resolvePath(tmpdir(), "pi-orch-"));
				writeFileSync(resolvePath(tempDir, "persona.md"), personaBody(raw) + "\n", "utf8");
			} catch (err) {
				return { ok: false, text: "", error: `persona 临时文件写入失败: ${(err as Error).message}` };
			}
		}

		// --- workdir: isolate this node's subprocess (parallel nodes otherwise
		// share one cwd and can stomp each other's files). validateGraph rejected
		// escapes; resolve()+containment here is defense in depth. ---
		let bridgeCwd = this.cwd;
		if (node.workdir) {
			const base = resolvePath(this.cwd ?? process.cwd());
			const resolved = resolvePath(base, node.workdir);
			if (resolved !== base && !resolved.startsWith(base + sep)) {
				return { ok: false, text: "", error: `workdir「${node.workdir}」越界（必须在 ${base} 内）` };
			}
			try {
				mkdirSync(resolved, { recursive: true });
			} catch (err) {
				return { ok: false, text: "", error: `workdir「${node.workdir}」创建失败: ${(err as Error).message}` };
			}
			bridgeCwd = resolved;
		}

		const extraArgs = ["--model", node.model ?? this.defaultModel];
		if (tempDir) extraArgs.push("--append-system-prompt", resolvePath(tempDir, "persona.md"));
		// Tool profile (pi 0.84.x): --tools is a strict allowlist, --exclude-tools
		// a denylist applied after it. Names are TOOL_NAME_RE-validated upstream,
		// so the comma-joined entry carries no cmd.exe metacharacters.
		if (node.tools?.length) extraArgs.push("--tools", node.tools.join(","));
		if (node.excludeTools?.length) extraArgs.push("--exclude-tools", node.excludeTools.join(","));

		const timeoutMs = node.timeoutMs ?? this.timeoutMs;
		const bridge = this.bridgeFactory({ extraArgs, cwd: bridgeCwd });
		const state = initState();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const onAbort = () => finish({ ok: false, text: "", error: "已中止" });

		function cleanup(): void {
			if (timer) clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onAbort);
			bridge.kill(); // idempotent; tree-kills on Windows
			if (tempDir) {
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {
					/* best-effort temp cleanup */
				}
			}
		}

		// finish() may be invoked from several racing paths; first one wins.
		const finish = (result: NodeResult): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		let resolve: (r: NodeResult) => void = () => {};
		const done = new Promise<NodeResult>((res) => {
			resolve = res;
		});

		bridge.on("event", (ev: JsonAgentSessionEvent) => {
			// Post-settle stdout still trickles in after kill(); folding more is
			// harmless but forwarding deltas would emit events for a finished node.
			if (settled) return;
			foldEvent(state, ev);
			if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
				ctx.onDelta("text", ev.assistantMessageEvent.delta);
			} else if (ev.type === "tool_execution_start") {
				ctx.onDelta("tool", `→ ${ev.toolName}\n`);
			} else if (ev.type === "agent_settled") {
				// Success path (unless a terminal error was folded earlier).
				if (state.lastError) {
					finish({ ok: false, text: finalOutput(state), error: state.lastError });
					return;
				}
				const last = lastAssistant(state.messages);
				finish({
					ok: true,
					text: finalOutput(state),
					stopReason: last?.stopReason ?? "stop",
					model: last?.model,
					usage: usageOf(state),
				});
			}
		});
		bridge.on("exit", (code: number | null, stderr: string) => {
			const tail = stderr.replace(/\s+/g, " ").trim().slice(-500);
			finish({ ok: false, text: "", error: `pi 进程退出 (code ${code ?? "null"})${tail ? `: ${tail}` : ""}` });
		});

		timer = setTimeout(() => finish({ ok: false, text: "", error: `节点超时（${timeoutMs}ms）` }), timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		ctx.signal.addEventListener("abort", onAbort);

		bridge.start();
		bridge
			.request({ type: "prompt", message: assembledPrompt })
			.then((res) => {
				if (!res.success) finish({ ok: false, text: "", error: `prompt 被拒绝: ${JSON.stringify(res.data ?? {})}` });
			})
			.catch((err: Error) => finish({ ok: false, text: "", error: err.message }));

		return done;
	}
}

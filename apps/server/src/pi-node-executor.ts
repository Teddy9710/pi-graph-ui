/**
 * PiNodeExecutor - production Executor: one pi rpc instance per node.
 *
 * Mirrors pi's own subagent fan-out pattern: `--no-session` in-memory
 * instance, persona body injected via a temp file + --append-system-prompt
 * (cmd.exe argv is capped at 8191 chars, so the TASK travels over stdin RPC,
 * never the command line). The node's event stream is folded locally with
 * the shared foldEvent; completion races agent_settled vs process exit vs
 * timeout, and the bridge is killed in every path (no orphaned trees).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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

	constructor(options: PiExecutorOptions = {}) {
		this.bin = options.bin;
		this.cwd = options.cwd;
		this.defaultModel = options.defaultModel ?? "deepseek/deepseek-chat";
		this.agentsDir = options.agentsDir ?? join(homedir(), ".pi", "agent", "agents");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async run(
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
				raw = readFileSync(join(this.agentsDir, `${node.agent}.md`), "utf8");
			} catch {
				return { ok: false, text: "", error: `未找到 agent「${node.agent}」（查找目录 ${this.agentsDir}）` };
			}
			try {
				tempDir = mkdtempSync(join(tmpdir(), "pi-orch-"));
				writeFileSync(join(tempDir, "persona.md"), personaBody(raw) + "\n", "utf8");
			} catch (err) {
				return { ok: false, text: "", error: `persona 临时文件写入失败: ${(err as Error).message}` };
			}
		}

		const extraArgs = ["--model", node.model ?? this.defaultModel];
		if (tempDir) extraArgs.push("--append-system-prompt", join(tempDir, "persona.md"));

		const bridge = new PiBridge({ bin: this.bin, cwd: this.cwd, extraArgs });
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

		timer = setTimeout(() => finish({ ok: false, text: "", error: `节点超时（${this.timeoutMs}ms）` }), this.timeoutMs);
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

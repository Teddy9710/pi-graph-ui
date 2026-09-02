/**
 * PiPlanner - decompose a free-text goal into a GraphDef via one pi instance.
 *
 * The planner is itself a `--no-session` pi rpc instance whose prompt asks for
 * a STRICT-JSON task DAG. Its final text is run through extractGraph (pure:
 * substring JSON → normalize → validateGraph); a malformed or invalid plan
 * retries ONCE with the validation error fed back. The streamed text is
 * surfaced through onDelta so the canvas can preview the plan as it drafts.
 *
 * Same lifecycle discipline as PiNodeExecutor: agent_settled vs exit vs
 * timeout vs abort race, and the bridge is killed on every path.
 */

import {
	EDGE_TYPES,
	finalOutput,
	foldEvent,
	initState,
	MAX_EDGE_NOTE_CHARS,
	MAX_MIN_OUTPUT_CHARS,
	MAX_NODE_TIMEOUT_MS,
	MAX_NODE_TOOLS,
	MAX_OUTPUT_CAP_BYTES,
	MODEL_RE,
	TOOL_NAME_RE,
	validateGraph,
	isSafeWorkdir,
	type EdgeType,
	type GraphDef,
	type JsonAgentSessionEvent,
} from "@pi-graph/shared";
import { PiBridge } from "./pi-bridge.ts";

// ============================================================================
// Pure pieces (exported for tests)
// ============================================================================

/** Hard ceiling on generated nodes — the prompt asks for 3-8. */
export const MAX_PLAN_NODES = 16;
/** Planner output is untrusted LLM text — bound every string it contributes. */
export const MAX_TASK_CHARS = 8000;
export const MAX_LABEL_CHARS = 100;
/** 16 nodes admit ≤240 unique edges; anything past this is garbage. */
export const MAX_PLAN_EDGES = 512;
/** Goals travel over stdin RPC (no argv limit) but are still capped. */
export const MAX_GOAL_CHARS = 4000;

export type PlanOutcome = { ok: true; graph: GraphDef } | { ok: false; error: string };

/** One planner turn's raw result (text not yet parsed). */
type AskOutcome = { ok: true; text: string } | { ok: false; error: string };

export function buildPlanPrompt(goal: string, feedback?: string): string {
	const base = `你是一个任务规划器。把下面的用户目标分解为一张可执行的任务 DAG（有向无环图）。

要求：
- 输出**只有一个 JSON 对象**，不要 markdown 代码块围栏、不要任何解释文字。
- 结构：{"nodes": [{"id": "n1", "label": "简短标签", "task": "给执行 agent 的完整任务指令"}], "edges": [{"source": "n1", "target": "n2", "type": "input", "label": "可选补充说明"}]}
- 节点 3 到 8 个，绝不超过 ${MAX_PLAN_NODES} 个。id 用 n1、n2、n3…（仅限字母/数字/_/-，不可重复）。
- edges 描述数据依赖：当 b 需要 a 的产出时连 a->b。每条边必须带一个 type，只能从这六个里选：input（输入：a 的产出是 b 的直接加工材料）、context（参考：a 的产出仅供 b 作背景参考）、review（审校：b 检查/评价 a 的产出）、revise（修订：b 按上游反馈修改自己的产出）、aggregate（汇总：b 把多个上游聚合成整体结论）、decide（决策：b 依据 a 的产出做选择/判断）；拿不准就用 input。label 可选且仅当 type 说不清依赖原因时才填，不超过 20 字，如「原始数据」「逐条核对」。不许环、不许自环。节点间关系要尽量显式表达为边；只有真正互不依赖的任务才作为独立根节点并行。
- 每个节点的 task 必须自包含：执行该节点的 agent 看不到整体目标，只看到自己的 task 与上游节点的输出。
- 可选字段 model（"provider/model"）与 agent（persona 名）通常省略，除非目标明确需要。

用户目标：
${goal}`;
	if (!feedback) return base;
	return `${base}

你上一次输出的 JSON 无法使用：${feedback}
请修正问题后重新输出——仍然只输出一个 JSON 对象，不要任何其他文字。`;
}

/**
 * Extract a GraphDef from a planner reply: substring JSON (models love to
 * wrap output in prose or ```json fences), then normalize (synthesize edge
 * ids, whitelist node fields, drop positions), then validateGraph.
 * Pure and total — never throws.
 */
export function extractGraph(text: string): PlanOutcome {
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last <= first) return { ok: false, error: "输出中没有找到 JSON 对象" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(first, last + 1));
	} catch (err) {
		return { ok: false, error: `JSON 解析失败: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { nodes?: unknown }).nodes) || !Array.isArray((parsed as { edges?: unknown }).edges)) {
		return { ok: false, error: "JSON 不是有效的图结构（需要 nodes/edges 数组）" };
	}
	const raw = parsed as { name?: unknown; nodes: unknown[]; edges: unknown[] };
	if (raw.nodes.length > MAX_PLAN_NODES) {
		return { ok: false, error: `节点数 ${raw.nodes.length} 超过上限 ${MAX_PLAN_NODES}` };
	}
	if (raw.edges.length > MAX_PLAN_EDGES) {
		return { ok: false, error: `边数 ${raw.edges.length} 超过上限 ${MAX_PLAN_EDGES}` };
	}
	// Normalize: keep only known fields with the right types, every string
	// length-capped (planner output is untrusted). Malformed entries pass
	// through so validateGraph (total) reports them by rule.
	const nodes = raw.nodes.map((n) => {
		if (typeof n !== "object" || n === null) return n;
		const r = n as Record<string, unknown>;
		// `gate` (HITL 门控) is deliberately NOT carried out of a plan: the
		// whitelist below drops it like every other unknown field, because a
		// gate is a human-placed editor construct — a model that learned to
		// emit one could suspend an unattended run indefinitely.
		const out: Record<string, string | number | string[]> = {};
		if (typeof r.id === "string") out.id = r.id.slice(0, 64);
		if (typeof r.task === "string") out.task = r.task.slice(0, MAX_TASK_CHARS);
		// Label rides in prompt section headers downstream (buildSynthPrompt
		// ### nodeId —— 标签) — normalize to one line like edge notes, so a
		// hostile planner label can neither forge headers nor fail validation.
		if (typeof r.label === "string") {
			const rawLabel = r.label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
			if (rawLabel) out.label = rawLabel.slice(0, MAX_LABEL_CHARS);
		}
		if (typeof r.model === "string" && r.model.trim()) out.model = r.model.slice(0, 128);
		if (typeof r.agent === "string" && r.agent.trim()) out.agent = r.agent.slice(0, 64);
		// Capability profile: clamp in-range numbers, keep safe shapes, drop
		// everything else. Dropping (not failing) keeps the single planner
		// retry reserved for structural errors; these fields are opt-in
		// niceties the prompt does not advertise, not load-bearing contracts.
		for (const [field, min, max] of [
			["minOutputChars", 0, MAX_MIN_OUTPUT_CHARS],
			["timeoutMs", 1_000, MAX_NODE_TIMEOUT_MS],
			["outputCapBytes", 1, MAX_OUTPUT_CAP_BYTES],
		] as const) {
			const v = r[field];
			if (typeof v === "number" && Number.isFinite(v)) {
				out[field] = Math.min(max, Math.max(min, Math.round(v)));
			}
		}
		if (typeof r.workdir === "string" && isSafeWorkdir(r.workdir)) out.workdir = r.workdir;
		for (const field of ["tools", "excludeTools"] as const) {
			const list = r[field];
			if (!Array.isArray(list)) continue;
			const names = list.filter((t): t is string => typeof t === "string" && TOOL_NAME_RE.test(t)).slice(0, MAX_NODE_TOOLS);
			if (names.length > 0) out[field] = names;
		}
		return out;
	});
	const edges = raw.edges.map((e) => {
		if (typeof e !== "object" || e === null) return e;
		const r = e as Record<string, unknown>;
		if (typeof r.source !== "string" || typeof r.target !== "string") return r;
		// LLMs routinely omit edge ids; synthesize the conventional one.
		// Edge TYPE: whitelist-keep only — an unknown or missing type is
		// DROPPED (the edge defaults to "input" downstream) rather than
		// failing validation, because burning the planner's single retry on a
		// cosmetic degradation costs up to a 3-minute timeout. Systematic
		// drift is caught loudly by the strict e2e contract instead.
		const type = typeof r.type === "string" && (EDGE_TYPES as readonly string[]).includes(r.type) ? (r.type as EdgeType) : undefined;
		// The optional note rides along, capped and normalized to one line
		// (newlines/control chars would fail validateGraph and waste the
		// retry). Dropped type must not drop the note — independent checks.
		const rawLabel = typeof r.label === "string" ? r.label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
		const label = rawLabel ? rawLabel.slice(0, MAX_EDGE_NOTE_CHARS) : undefined;
		return {
			id: typeof r.id === "string" && r.id ? r.id : `${r.source}->${r.target}`,
			source: r.source,
			target: r.target,
			...(type ? { type } : {}),
			...(label ? { label } : {}),
		};
	});
	const graph: GraphDef = {
		nodes: nodes as GraphDef["nodes"],
		edges: edges as GraphDef["edges"],
	};
	const issues = validateGraph(graph);
	if (issues.length > 0) {
		const shown = issues
			.slice(0, 3)
			.map((i) => (i.nodeOrEdge ? `${i.nodeOrEdge}：` : "") + i.message)
			.join("；");
		return { ok: false, error: `图校验未通过：${shown}${issues.length > 3 ? `（等 ${issues.length} 项）` : ""}` };
	}
	return { ok: true, graph };
}

// ============================================================================
// Bridge seam (injectable for tests)
// ============================================================================

/** The PiBridge surface PiPlanner uses — narrow so a fake can stand in. */
export interface PlannerBridge {
	on(event: "event", fn: (ev: JsonAgentSessionEvent) => void): unknown;
	on(event: "exit", fn: (code: number | null, stderr: string) => void): unknown;
	start(): void;
	request(command: { type: "prompt"; message: string }): Promise<{ success: boolean; data?: unknown }>;
	kill(): void;
}

export interface PiPlannerOptions {
	/** pi executable; defaults to PiBridge's own resolution (pi/pi.cmd). */
	bin?: string;
	cwd?: string;
	/** Planner model id (argv-validated before spawn). */
	model?: string;
	/** Per-attempt wall clock budget. Default 3 minutes. */
	timeoutMs?: number;
	/** Total attempts including the first. Default 2 (one retry). */
	maxAttempts?: number;
	/** Test seam; default builds a real PiBridge with --model <model>. */
	bridgeFactory?: (extraArgs: string[]) => PlannerBridge;
}

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

// ============================================================================
// Planner
// ============================================================================

export class PiPlanner {
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly maxAttempts: number;
	private readonly bridgeFactory: (extraArgs: string[]) => PlannerBridge;

	constructor(options: PiPlannerOptions = {}) {
		this.model = options.model ?? "deepseek/deepseek-chat";
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
		this.bridgeFactory =
			options.bridgeFactory ?? ((extraArgs) => new PiBridge({ bin: options.bin, cwd: options.cwd, extraArgs }));
	}

	/**
	 * Plan a goal into a validated GraphDef. Streams the planner's text via
	 * onDelta (draft preview); honors abort; retries once on a bad plan.
	 */
	async plan(
		goal: string,
		ctx: { onDelta: (delta: string) => void; signal: AbortSignal },
	): Promise<PlanOutcome> {
		const trimmed = goal.trim();
		if (!trimmed) return { ok: false, error: "目标不能为空" };
		const capped =
			trimmed.length <= MAX_GOAL_CHARS ? trimmed : `${trimmed.slice(0, MAX_GOAL_CHARS)}\n（目标过长，已截断）`;
		// The model id passes through a cmd.exe shim; refuse metacharacters
		// before spawning (ORCH_PLANNER_MODEL is env-supplied, not user input,
		// but the guard costs nothing).
		if (!MODEL_RE.test(this.model)) return { ok: false, error: `规划模型「${this.model}」含非法字符` };

		let feedback: string | undefined;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (attempt > 1) {
				ctx.onDelta(`\n\n—— 第 ${attempt - 1} 次规划无效：${feedback ?? ""}，正在重试 ——\n\n`);
			}
			const asked = await this.askOnce(buildPlanPrompt(capped, feedback), ctx);
			if (!asked.ok) return asked; // process-level failure — retrying the same env won't help
			const extracted = extractGraph(asked.text);
			if (extracted.ok) return extracted;
			feedback = extracted.error;
		}
		return { ok: false, error: feedback ?? "规划失败" };
	}

	/** One planner turn: spawn → prompt over stdin → race settle/exit/timeout/abort. */
	private askOnce(prompt: string, ctx: { onDelta: (delta: string) => void; signal: AbortSignal }): Promise<AskOutcome> {
		const bridge = this.bridgeFactory(["--model", this.model]);
		const state = initState();
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const onAbort = () => finish({ ok: false, error: "已中止" });

		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onAbort);
			bridge.kill(); // idempotent; tree-kills on Windows
		};
		const finish = (result: AskOutcome): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		let resolve: (r: AskOutcome) => void = () => {};
		const done = new Promise<AskOutcome>((res) => {
			resolve = res;
		});

		bridge.on("event", (ev: JsonAgentSessionEvent) => {
			// Post-settle stdout trickles in after kill(); stop folding and,
			// more importantly, stop forwarding deltas for a finished attempt.
			if (settled) return;
			foldEvent(state, ev);
			if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
				ctx.onDelta(ev.assistantMessageEvent.delta);
			} else if (ev.type === "agent_settled") {
				if (state.lastError) {
					finish({ ok: false, error: `规划模型出错: ${state.lastError}` });
					return;
				}
				finish({ ok: true, text: finalOutput(state) });
			}
		});
		bridge.on("exit", (code: number | null, stderr: string) => {
			const tail = stderr.replace(/\s+/g, " ").trim().slice(-500);
			finish({ ok: false, error: `规划进程退出 (code ${code ?? "null"})${tail ? `: ${tail}` : ""}` });
		});

		timer = setTimeout(() => finish({ ok: false, error: `规划超时（${this.timeoutMs}ms）` }), this.timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		ctx.signal.addEventListener("abort", onAbort);

		bridge.start();
		bridge
			.request({ type: "prompt", message: prompt })
			.then((res) => {
				if (!res.success) finish({ ok: false, error: `规划 prompt 被拒绝: ${JSON.stringify(res.data ?? {})}` });
			})
			.catch((err: Error) => finish({ ok: false, error: err.message }));

		return done;
	}
}

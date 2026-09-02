#!/usr/bin/env node
/**
 * E2E for MULTI-PATH PARALLEL orchestration - expects the bridge server on
 * :8787. Demonstrates the engine's fan-out / AND-join 能力 end to end and
 * ASSERTS that parallel branches genuinely ran concurrently, not just that the
 * graph was structured that way.
 *
 *   goal(main)
 *    ├── p1 ──┐       每个 pN 是一个独立 pi --no-session 节点，
 *    ├── p2 ──┤       相互之间没有任何依赖 → 多路并行扇出
 *    ├── p3 ──┤→ join  join 是 AND-join sink：等全部上游 ok 才起跑，
 *    └── p4 ──┘          并把所有分支产出收拢成一份汇总
 *
 * Claims it verifies (each a hard assertion, not a soft log):
 *   1. STRUCTURE   —— 有效的多路 DAG；聚合 sink 从 >= 2 条分支扇入（真正的分叉）。
 *   2. PARALLELISM —— 分支节点的 [start,end] 时间窗存在真实重叠：任意时刻至少 2 条
 *                     分支同时在中途，且整段墙钟明显小于「串行时长之和」（真并发会显著
 *                     缩短用时；若只是结构上并行而实际逐个跑，则墙钟 ~ 之和，断言失败）。
 *                     ORCH_MAX_PARALLEL<2 时真并发不可能，该断言自动降级并如实打印。
 *   3. AND-JOIN  —— 聚合节点的 assembledPrompt 带全部上游分支的 `### from <id>` 区块
 *                     头；其 startedAt 不早于最晚完成分支的 endedAt（它真的等到了最后
 *                     一条，而不是边到边同步）。
 *   4. SAFETY     —— 无孤儿 pi 节点进程（Windows 基线快照 diff）；run 归档一致；
 *                     新连接 hello 能重放整条 run。
 *
 * PLAN=1 mode: AUTO-ORCHESTRATION（自动编排）—— 把同样的「多路并行」拓扑交给 AI 规划器
 * 现场拆图（goal 明确要求 4 条相互独立、可并行执行的分支 + 一个汇总节点），然后对同一
 * runId 执行，复用以上全部并行断言。这验证的是系统「自动编排」那条路：一个自然语言目标
 * → 多路并行任务 DAG → 并行执行 → 汇聚。
 *
 * Usage: node scripts/e2e-parallel.mjs            (manual multi-path parallel graph)
 *        PLAN=1 node scripts/e2e-parallel.mjs     (AI auto-orchestrates the parallel graph)
 */

import { execFileSync } from "node:child_process";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const HTTP = URL.replace(/^ws/, "http");
const PLAN = process.env.PLAN === "1";
const MAX_PARALLEL = Math.max(1, Number(process.env.ORCH_MAX_PARALLEL || 4) || 4);

/** All typed-edge badges — an AND-join carries every upstream as one of these. */
const BADGES = "输入|参考|审校|修订|汇总|决策";

/**
 * Auto-orchestration goal for PLAN mode. Deliberately spells out the topology
 * the planner must turn into a GraphDef: 4 independent branches that MAY run in
 * parallel + one join that collates them. The generated graph is then asserted
 * to have a real multi-path fan-in, and its execution asserted to overlap.
 */
const GOAL =
	"请把下面这个目标自动编排成一个「多路并行」的任务 DAG：想研究『如何快速学会骑自行车、游泳、弹吉他、打字这四件事』。" +
	"请拆成 4 个互相独立、没有任何依赖、因此可以同时并行执行的子任务（一个子任务只研究其中一件事，各自的要点写成纯文本），" +
	"再加一个汇总任务，它依赖全部那 4 个子任务，把四份要点按小标题整理成一份总的行动指南。所有任务的输出都只要紧凑的纯文本要点，不要代码块。";

function fail(msg) {
	console.error(`\nE2E FAILED: ${msg}`);
	process.exit(1);
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(URL);
		ws.onopen = () => resolve(ws);
		ws.onerror = (err) => reject(new Error(`WS error: ${err.message ?? err}`));
	});
}

/** Live pi rpc node processes (win32 only; null = cannot probe → leak check skipped). */
function listPiPids() {
	if (process.platform !== "win32") return null;
	let out;
	try {
		out = execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'coding-agent' } | Select-Object -ExpandProperty ProcessId",
			],
			{ encoding: "utf8" },
		);
	} catch (err) {
		throw new Error(`pi 进程查询失败（孤儿检查不可用）: ${err.message}`);
	}
	const pids = new Set();
	for (const line of out.split(/\r?\n/)) {
		const s = line.trim();
		if (!s) continue;
		const pid = Number(s);
		if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pi 进程查询返回了无法解析的输出: ${JSON.stringify(line)}`);
		pids.add(pid);
	}
	return pids;
}

function leakedPids(baseline) {
	const now = listPiPids();
	if (now === null || baseline === null) return null;
	return [...now].filter((pid) => !baseline.has(pid));
}

async function assertNoLeaks(baseline) {
	await new Promise((r) => setTimeout(r, 3000));
	const leaked = leakedPids(baseline);
	if (leaked === null) {
		console.log("  [orphans] non-win32 platform: pid leak check skipped");
		return;
	}
	if (leaked.length > 0) fail(`${leaked.length} orphaned pi process(es) after run (pids: ${leaked.join(", ")})`);
}

/**
 * A deliberately slow counting task keeps every branch comfortably in flight,
 * so the scheduler has real headroom to overlap them under maxParallel. The
 * exact high-water mark is a heuristic for the model's per-line pace — the
 * timing assertions only need SOME overlap, so a fast machine overlaps just
 * differently, not not-at-all.
 */
const BRANCHES = [1, 2, 3, 4].map((i, idx) => ({
	id: `p${i}`,
	task:
		`请慢慢数数，从 1 数到 ${70 + idx * 5}，每个数字单独一行整数，最后一行再单独输出一句「我是分支 ${i}」。不要做任何其他事，不要解释，不要代码块。`,
}));

const JOIN =
	"上游是四条并行分支各自的产出（各有小标题标记 p1/p2/p3/p4）。请按 p1、p2、p3、p4 的顺序整理成四段紧凑要点，每段以「【pN】」开头，并在开头加一句总起句。只输出整理后的内容，不要代码块。";

/** Manual multi-path parallel graph: 4 independent leaves + 1 AND-join sink. */
const graph = {
	name: "e2e-parallel",
	nodes: [...BRANCHES, { id: "join", task: JOIN }],
	edges: [
		{ id: "p1->join", source: "p1", target: "join", type: "input" },
		{ id: "p2->join", source: "p2", target: "join", type: "input" },
		{ id: "p3->join", source: "p3", target: "join", type: "input" },
		{ id: "p4->join", source: "p4", target: "join", type: "aggregate", label: "收拢四条分支" },
	],
};

const events = [];
const ws = await connect();
const mode = PLAN ? "PLAN (auto-orchestration)" : "manual multi-path parallel";
console.log(`connected to ${URL} (${mode}, ORCH_MAX_PARALLEL=${MAX_PARALLEL})`);
const timeout = setTimeout(() => fail("run did not finish in time (180s)"), 180_000);

ws.onmessage = (msg) => {
	const envelope = JSON.parse(String(msg.data));
	if (envelope.type !== "run_event") return;
	const e = envelope.event;
	events.push(e);
	if (e.type === "plan_started") console.log(`  [plan] started (goal: ${e.goal.slice(0, 46)}…)`);
	if (e.type === "plan_delta") process.stdout.write(".");
	if (e.type === "plan_completed") console.log(`\n  [plan] graph: ${e.graph.nodes.length} nodes / ${e.graph.edges.length} edges`);
	if (e.type === "plan_failed") console.log(`  [plan] FAILED: ${e.error}`);
	if (e.type === "run_started") console.log(`  [run] started (${e.graph.nodes.length} nodes, ${e.graph.edges.length} edges)`);
	if (e.type === "node_started") console.log(`  [node] ${e.nodeId} started`);
	if (e.type === "node_completed") console.log(`  [node] ${e.nodeId} ok (${e.durationMs}ms)`);
	if (e.type === "node_failed") console.log(`  [node] ${e.nodeId} FAILED: ${e.error}`);
	if (e.type === "node_skipped") console.log(`  [node] ${e.nodeId} skipped (${e.reason})`);
	if (e.type === "run_finished") {
		clearTimeout(timeout);
		ws.close();
		finish(e).catch((err) => fail(err.message));
	}
};

const baselinePids = listPiPids();

if (PLAN) {
	ws.send(JSON.stringify({ type: "plan_run", goal: GOAL }));
	console.log("plan_run sent (auto-orchestration)");
} else {
	ws.send(JSON.stringify({ type: "run_graph", graph }));
	console.log("run_graph sent (4 parallel branches → AND-join)");
}

async function finish(runFin) {
	const byType = (t) => events.filter((e) => e.type === t);
	const startedBy = (id) => byType("node_started").find((e) => e.nodeId === id);
	const completedBy = (id) => byType("node_completed").find((e) => e.nodeId === id);

	if (runFin.status !== "completed") {
		fail(`expected status "completed", got "${runFin.status}" (node_failed: ${JSON.stringify(byType("node_failed"))})`);
	}

	if (PLAN) {
		if (!byType("plan_started")[0]) fail("no plan_started event");
		if (byType("plan_delta").length === 0) fail("no plan_delta events streamed");
		const planCompleted = byType("plan_completed")[0];
		if (!planCompleted) fail("no plan_completed event");
		const runStarted = byType("run_started")[0];
		if (planCompleted.runId !== runStarted.runId) fail("runId changed across plan→run handoff");
		console.log(`  [plan] auto-graph: ${planCompleted.graph.nodes.length} nodes / ${planCompleted.graph.edges.length} edges`);
	}

	// ---- 0. resolve the graph under execution (source of truth for timing).
	// Manual mode uses our graph; plan mode uses what the planner generated.
	const runGraph = PLAN ? byType("run_started")[0].graph : graph;

	// ---- 1. STRUCTURE: discover the aggregate join + its upstream leaves.
	// In manual mode these are join + p1..p4; in PLAN mode whatever the planner
	// produced — we discover rather than assume ids.
	const incoming = (id) => runGraph.edges.filter((e) => e.target === id).map((e) => e.source);
	const joinId =
		runGraph.nodes
			.filter((n) => incoming(n.id).length >= 2)
			.sort((a, b) => incoming(b.id).length - incoming(a.id).length || String(a.id).localeCompare(String(b.id)))[0]?.id ??
		null;
	if (!joinId) fail("graph has no fan-in join node (multi-path aggregation missing)");
	const branchIds = runGraph.nodes.filter((n) => n.id !== joinId).map((n) => n.id);
	const joinIncoming = incoming(joinId);
	if (joinIncoming.length < 2) fail(`join ${joinId} fans in from only ${joinIncoming.length} upstream(s), expected >= 2`);

	const joinStarted = startedBy(joinId);
	if (!joinStarted) fail(`join node ${joinId} never started`);

	// ---- 2. PARALLELISM: upstream-leaf [start,end] windows really overlap.
	const windows = branchIds.map((id) => {
		const s = startedBy(id);
		const c = completedBy(id);
		if (!s || !c) fail(`branch ${id} missing start/complete (started=${!!s}, completed=${!!c})`);
		return { id, start: s.startedAt, end: c.endedAt, dur: c.durationMs };
	});
	let maxConcurrent = 1;
	for (let i = 0; i < windows.length; i++) {
		for (let j = i + 1; j < windows.length; j++) {
			const a = windows[i], b = windows[j];
			if (a.start < b.end && b.start < a.end) maxConcurrent = Math.max(maxConcurrent, 2);
		}
	}
	const earliestStart = Math.min(...windows.map((w) => w.start));
	const latestEnd = Math.max(...windows.map((w) => w.end));
	const branchWall = latestEnd - earliestStart;
	const branchSum = windows.reduce((acc, w) => acc + w.dur, 0);

	if (MAX_PARALLEL >= 2 && windows.length >= 2) {
		// Hard claim: >= 2 leaves were in the air simultaneously AND the wall
		// clock is well under the serial lower bound (sum). Both must hold —
		// the first proves concurrency, the second proves it SHORTENED the run
		// (genuine multi-path parallelism, not a structurally-parallel graph
		// that happened to run one leaf after another).
		if (maxConcurrent < 2) fail(`no two branches overlapped (maxConcurrent=${maxConcurrent}) — likely not running in parallel`);
		if (branchWall >= branchSum * 0.6) {
			fail(`branches overlapped but wall (${Math.round(branchWall)}ms) ~ sum (${Math.round(branchSum)}ms): not effectively parallel`);
		}
		console.log(
			`  [parallel] ${maxConcurrent}+/${windows.length} branches concurrent; wall=${Math.round(branchWall)}ms vs Σdurations=${Math.round(branchSum)}ms`,
		);
	} else {
		console.log(
			`  [parallel] ORCH_MAX_PARALLEL=${MAX_PARALLEL}, leaves=${windows.length} — strict overlap claim not applicable (wall=${Math.round(branchWall)}ms vs Σ=${Math.round(branchSum)}ms)`,
		);
	}

	// ---- 3. AND-JOIN: the sink waited for the last upstream leaf + carried all.
	const joinEarliestAllowed = Math.max(...windows.map((w) => w.end));
	if (joinStarted.startedAt < joinEarliestAllowed) {
		fail(`join started ${joinStarted.startedAt - joinEarliestAllowed}ms BEFORE the last branch finished — AND-join violated`);
	}
	const prompt = joinStarted.assembledPrompt;
	const carried = new Set(
		[...prompt.matchAll(new RegExp(`### from ([A-Za-z0-9_-]+) —— (?:${BADGES})`, "g"))].map((m) => m[1]),
	);
	for (const b of joinIncoming) {
		if (!carried.has(b) && branchIds.includes(b)) fail(`join prompt missing typed upstream header for ${b}`);
	}
	const joinDone = completedBy(joinId);
	if (!joinDone) fail(`join node ${joinId} never completed`);
	console.log(
		`  [and-join] ${joinIncoming.length} branch(es) fanned in; join started ${Math.round(joinStarted.startedAt - joinEarliestAllowed)}ms after the last branch finished; collated output ${joinDone.output.text.length} chars`,
	);

	// ---- 4. SAFETY: archive + replay + no orphans.
	const runs = await (await fetch(`${HTTP}/api/runs`)).json();
	const meta = runs[0];
	if (!meta || meta.status !== "completed") fail(`/api/runs head is ${JSON.stringify(meta)}`);
	const archived = await (await fetch(`${HTTP}/api/runs/${meta.id}`)).json();
	if (archived.length !== events.length) fail(`archive has ${archived.length} events, stream had ${events.length}`);
	console.log(`  [archive] ${meta.id}: ${archived.length} events, status=${meta.status}`);

	const ws2 = await connect();
	const hello = await new Promise((resolve) => {
		ws2.onmessage = (msg) => {
			const env = JSON.parse(String(msg.data));
			if (env.type === "hello") resolve(env);
		};
	});
	ws2.close();
	if (!Array.isArray(hello.run) || hello.run.length !== events.length) {
		fail(`hello replay has ${hello.run?.length} run events, expected ${events.length}`);
	}
	console.log(`  [replay] hello carries ${hello.run.length} run events`);

	await assertNoLeaks(baselinePids);
	console.log(`\nE2E OK (${mode}): structure + parallelism + AND-join + archive + replay verified`);
	process.exit(0);
}

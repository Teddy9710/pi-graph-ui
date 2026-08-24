#!/usr/bin/env node
/**
 * E2E for graph orchestration - expects the bridge server on :8787.
 *
 * Default mode: run a 2-node chain over WebSocket and assert the core
 * contract - node b's prompt contains node a's output, the run completes,
 * deltas streamed, the run archived, and a fresh WS connection replays the
 * finished run from hello.
 *
 * ABORT=1 mode: start a slow chain, abort after the first delta, assert
 * run_finished{status:"aborted"} + downstream skipped + NO orphaned pi
 * node processes left behind (Windows tree-kill check).
 *
 * PLAN=1 mode: auto-orchestration - send one goal, assert the planner
 * streams a plan (plan_started/delta/completed), the SAME runId continues
 * into run_started with the generated graph, every generated node completes,
 * the archive keeps the plan events, and the planner bridge left no orphans.
 *
 * Usage: node scripts/e2e-orch.mjs        (normal)
 *        ABORT=1 node scripts/e2e-orch.mjs
 *        PLAN=1  node scripts/e2e-orch.mjs
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const HTTP = URL.replace(/^ws/, "http");
const ABORT = process.env.ABORT === "1";
const PLAN = process.env.PLAN === "1";
const GOAL =
	process.env.PLAN_GOAL ??
	"自动编排冒烟测试：请严格拆成三个串行依赖的任务——第一个任务只输出数字 7；第二个任务把上游数字加 1 后只输出结果；第三个任务再把这个数字加 1 后只输出结果。";

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

/** Count live pi rpc node processes (0 expected when no run is active). */
function countPiProcesses() {
	if (process.platform !== "win32") return 0;
	const out = execFileSync(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			"(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'coding-agent' }).Count",
		],
		{ encoding: "utf8" },
	);
	return Number(out.trim()) || 0;
}

const graph = ABORT
	? {
			name: "e2e-abort",
			nodes: [
				{ id: "slow", task: "从 1 慢慢数到 30，每个数字单独一行，不要做任何其他事。" },
				{ id: "never", task: "只输出：不该跑到这里" },
			],
			edges: [{ id: "slow->never", source: "slow", target: "never" }],
		}
	: {
			name: "e2e-chain",
			nodes: [
				{ id: "a", task: "只输出数字 7，不要任何其他文字。" },
				{ id: "b", task: "上游输入里有一个数字。把它加 1，只输出最终数字。" },
			],
			edges: [{ id: "a->b", source: "a", target: "b", label: "传递上游数字" }],
		};

const events = [];
const ws = await connect();
const mode = PLAN ? "PLAN mode" : ABORT ? "ABORT mode" : "chain mode";
console.log(`connected to ${URL} (${mode})`);

const timeout = setTimeout(() => fail("run did not finish in 240s"), 240_000);

let aborted = false;
ws.onmessage = (msg) => {
	const envelope = JSON.parse(String(msg.data));
	if (envelope.type !== "run_event") return;
	const e = envelope.event;
	events.push(e);
	if (e.type === "plan_started") console.log(`  [plan] started (goal: ${e.goal.slice(0, 40)}…)`);
	if (e.type === "plan_delta") process.stdout.write(".");
	if (e.type === "plan_completed") console.log(`\n  [plan] graph: ${e.graph.nodes.length} nodes, ${e.graph.edges.length} edges`);
	if (e.type === "plan_failed") console.log(`  [plan] FAILED: ${e.error}`);
	if (e.type === "node_started") console.log(`  [node] ${e.nodeId} started`);
	if (e.type === "node_delta" && ABORT && !aborted) {
		aborted = true;
		console.log("  [abort] first delta seen - sending abort_run");
		ws.send(JSON.stringify({ type: "abort_run" }));
	}
	if (e.type === "node_completed") console.log(`  [node] ${e.nodeId} ok (${e.durationMs}ms)`);
	if (e.type === "node_failed") console.log(`  [node] ${e.nodeId} FAILED: ${e.error}`);
	if (e.type === "node_skipped") console.log(`  [node] ${e.nodeId} skipped (${e.reason})`);
	if (e.type === "run_finished") {
		clearTimeout(timeout);
		ws.close();
		finish(e).catch((err) => fail(err.message));
	}
};

if (PLAN) {
	ws.send(JSON.stringify({ type: "plan_run", goal: GOAL }));
	console.log("plan_run sent");
} else {
	ws.send(JSON.stringify({ type: "run_graph", graph }));
	console.log("run_graph sent");
}

async function finish(fin) {
	const types = events.map((e) => e.type);
	const byType = (t) => events.filter((e) => e.type === t);

	// --- shared assertions ---
	if (fin.status === "failed") {
		const planErr = byType("plan_failed")[0];
		fail(`run failed: ${planErr ? planErr.error : JSON.stringify(byType("node_failed"))}`);
	}
	if (!types.includes("run_started")) fail("no run_started event");
	if (byType("node_delta").length === 0) fail("no node_delta events streamed");

	if (PLAN) {
		if (fin.status !== "completed") fail(`expected status "completed", got "${fin.status}"`);
		// Plan phase: streamed a draft and completed with a generated graph.
		const planStarted = byType("plan_started")[0];
		if (!planStarted) fail("no plan_started event");
		if (planStarted.goal !== GOAL) fail(`plan_started goal mismatch: ${planStarted.goal}`);
		if (byType("plan_delta").length === 0) fail("no plan_delta events streamed");
		const planCompleted = byType("plan_completed")[0];
		if (!planCompleted) fail("no plan_completed event");
		const gen = planCompleted.graph;
		if (!Array.isArray(gen.nodes) || gen.nodes.length < 2 || gen.nodes.length > 16) {
			fail(`generated graph has ${gen.nodes?.length} nodes (expected 2-16)`);
		}
		// The SAME runId carries the plan into execution.
		const runStarted = byType("run_started")[0];
		if (runStarted.runId !== planStarted.runId) {
			fail(`runId changed across the plan→run handoff: ${planStarted.runId} → ${runStarted.runId}`);
		}
		const runIds = gen.nodes.map((n) => n.id).sort().join(",");
		const startedIds = runStarted.graph.nodes.map((n) => n.id).sort().join(",");
		if (runIds !== startedIds) fail("run_started.graph differs from plan_completed.graph");
		// Every generated node executed ok.
		if (fin.ok !== gen.nodes.length || fin.failed !== 0) {
			fail(`generated ${gen.nodes.length} nodes but finished ok=${fin.ok} failed=${fin.failed}`);
		}
		// The GOAL mandates a serial 3-task chain — an edgeless plan must fail
		// loudly, not pass vacuously past the label assertions below.
		if (gen.edges.length < 2) {
			fail(`goal mandates a serial 3-task chain but the plan has ${gen.edges.length} edge(s)`);
		}
		// Any edge means at least one downstream prompt carried upstream input,
		// and every generated edge carries its relation label (the prompt
		// mandates one) which annotates the injected section header.
		if (gen.edges.length > 0) {
			const injected = byType("node_started").some((e) => e.assembledPrompt.includes("## 上游输入"));
			if (!injected) fail("edges exist but no node prompt contains upstream input");
			const unlabeled = gen.edges.filter((e) => typeof e.label !== "string" || !e.label.trim());
			if (unlabeled.length > 0) {
				fail(`generated edges without relation labels: ${unlabeled.map((e) => e.id).join(",")}`);
			}
			const labeledHeader = byType("node_started").some((e) => e.assembledPrompt.includes("—— 关系："));
			if (!labeledHeader) fail("edge labels exist but no assembledPrompt carries the relation header");
		}
		// Archive keeps the full plan→run story, replays on reconnect.
		const runs = await (await fetch(`${HTTP}/api/runs`)).json();
		const meta = runs[0];
		if (!meta || meta.status !== "completed") fail(`/api/runs head is ${JSON.stringify(meta)}`);
		const archived = await (await fetch(`${HTTP}/api/runs/${meta.id}`)).json();
		if (archived.length !== events.length) {
			fail(`archive has ${archived.length} events, stream had ${events.length}`);
		}
		if (archived[0].type !== "plan_started") fail("archive does not start with plan_started");
		// The planner bridge must be dead with the run.
		await new Promise((r) => setTimeout(r, 3000));
		const leaked = countPiProcesses();
		if (leaked > 0) fail(`${leaked} orphaned pi process(es) after plan run`);
		console.log(`\nE2E OK (plan): ${gen.nodes.length} generated nodes ran to completion under one runId`);
		process.exit(0);
	}

	if (ABORT) {
		if (fin.status !== "aborted") fail(`expected status "aborted", got "${fin.status}"`);
		const skipped = byType("node_skipped");
		if (!skipped.some((e) => e.nodeId === "never")) fail("downstream node was not skipped on abort");
		// Orphan check: give taskkill a moment, then no pi node process may remain.
		await new Promise((r) => setTimeout(r, 3000));
		const leaked = countPiProcesses();
		if (leaked > 0) fail(`${leaked} orphaned pi process(es) after abort`);
		console.log("\nE2E OK (abort): status=aborted, downstream skipped, no orphaned processes");
		process.exit(0);
	}

	// --- chain mode ---
	if (fin.status !== "completed") fail(`expected status "completed", got "${fin.status}"`);
	if (fin.ok !== 2 || fin.failed !== 0) fail(`bad counts: ok=${fin.ok} failed=${fin.failed}`);

	const startedB = byType("node_started").find((e) => e.nodeId === "b");
	if (!startedB) fail("node b never started");
	// THE core contract: a's output reached b's prompt.
	if (!startedB.assembledPrompt.includes("7")) fail("b's assembledPrompt does not contain a's output (7)");
	// Semantic edge: the relation label annotates the injected section header.
	if (!startedB.assembledPrompt.includes("—— 关系：传递上游数字")) {
		fail("b's assembledPrompt does not carry the edge relation label");
	}
	const completedB = byType("node_completed").find((e) => e.nodeId === "b");
	if (!completedB) fail("node b never completed");
	// The model's arithmetic is nondeterministic (observed 7→"9" once); only
	// assert it produced a numeric answer, not WHICH number.
	if (!/\d/.test(completedB.output.text)) fail(`b's output has no digits: ${completedB.output.text}`);
	if (completedB.output.usage.totalTokens <= 0) fail("b's usage missing");

	// Archive: HTTP API serves the finished run.
	const runs = await (await fetch(`${HTTP}/api/runs`)).json();
	const meta = runs[0];
	if (!meta || meta.status !== "completed") fail(`/api/runs head is ${JSON.stringify(meta)}`);
	const archived = await (await fetch(`${HTTP}/api/runs/${meta.id}`)).json();
	if (archived.length !== events.length) fail(`archive has ${archived.length} events, stream had ${events.length}`);
	console.log(`  [archive] ${meta.id}: ${archived.length} events, status=${meta.status}`);

	// Reconnect: hello must replay the retained run (browser-refresh path).
	const ws2 = await connect();
	const hello = await new Promise((resolve) => {
		ws2.onmessage = (msg) => {
			const envelope = JSON.parse(String(msg.data));
			if (envelope.type === "hello") resolve(envelope);
		};
	});
	ws2.close();
	if (!Array.isArray(hello.run) || hello.run.length !== events.length) {
		fail(`hello replay has ${hello.run?.length} run events, expected ${events.length}`);
	}
	console.log(`  [replay] hello carries ${hello.run.length} run events`);

	console.log("\nE2E OK (chain): a→b injection, completion, archive, replay all verified");
	process.exit(0);
}

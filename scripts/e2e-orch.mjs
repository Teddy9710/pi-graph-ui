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
 * CHAT=1 mode: chat-first orchestration - plan_run with chat:true. Runs the
 * full PLAN-mode assertion set, then KEEPS the socket open: the server must
 * inject the compiled node outputs into the main session agent as a
 * sentinel-prefixed user message (line 2 JSON nodeCount === run_finished.ok),
 * and the agent must stream a non-empty integrated answer afterwards
 * (assistant message_end + agent_settled). Finally a fresh connection's hello
 * must replay both the sentinel message and the run events.
 *
 * Usage: node scripts/e2e-orch.mjs        (normal)
 *        ABORT=1 node scripts/e2e-orch.mjs
 *        PLAN=1  node scripts/e2e-orch.mjs
 *        CHAT=1  node scripts/e2e-orch.mjs
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const HTTP = URL.replace(/^ws/, "http");
const ABORT = process.env.ABORT === "1";
const PLAN = process.env.PLAN === "1";
const CHAT = process.env.CHAT === "1";
const GOAL =
	process.env.PLAN_GOAL ??
	"自动编排冒烟测试：请严格拆成三个串行依赖的任务——第一个任务只输出数字 7；第二个任务把上游数字加 1 后只输出结果；第三个任务再把这个数字加 1 后只输出结果。";

/** Mirrors shared EDGE_TYPES — deliberately LOCAL so a vocabulary change that
 *  forgets this contract shows up as an e2e failure, not a silent pass. */
const VALID_TYPES = ["input", "context", "review", "revise", "aggregate", "decide"];
/** Mirrors shared ORCH_RESULTS_SENTINEL (same reasoning as VALID_TYPES). */
const SENTINEL = "[pi-graph:orch-results]";

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

/**
 * Live pi rpc node process PIDs as a Set (win32 only; null = cannot probe on
 * this platform → leak checks are skipped).
 *
 * The old COUNT-based probe had two defects (eval F8): it matched EVERY
 * node.exe on the machine whose command line mentions 'coding-agent' — this
 * session, other projects, the main bridge — so unrelated processes produced
 * false orphan reports; and `Number(out.trim()) || 0` turned any PowerShell
 * failure into "0 processes" (fail-open, leaks passed silently). The PID-set
 * snapshot diff fixes both: a baseline is taken before the run starts, and
 * only processes that appeared AFTER it count as this run's leaks. A broken
 * query now fails loudly instead of reading as zero.
 */
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
		if (!Number.isInteger(pid) || pid <= 0) {
			throw new Error(`pi 进程查询返回了无法解析的输出: ${JSON.stringify(line)}`);
		}
		pids.add(pid);
	}
	return pids;
}

/** PIDs alive now but absent from the baseline (this run's true leak); null when the probe is unavailable. */
function leakedPids(baseline) {
	const now = listPiPids();
	if (now === null || baseline === null) return null;
	return [...now].filter((pid) => !baseline.has(pid));
}

/** Shared tail of every orphan check: wait for taskkill, then diff against the baseline. */
async function assertNoLeaks(stage, baseline) {
	await new Promise((r) => setTimeout(r, 3000)); // give Windows taskkill a moment
	const leaked = leakedPids(baseline);
	if (leaked === null) {
		console.log("  [orphans] non-win32 platform: pid leak check skipped");
		return;
	}
	if (leaked.length > 0) fail(`${leaked.length} orphaned pi process(es) after ${stage} (pids: ${leaked.join(", ")})`);
}

const graph = ABORT
	? {
			name: "e2e-abort",
			// Count-to-100 keeps the slow node comfortably mid-flight when the
			// abort lands: with count-to-30 it once finished ~14.6s BEFORE the
			// abort propagated, leaving "never" aborted-in-flight (node_failed)
			// instead of unstarted (node_skipped) — a legit outcome the old
			// skip-only assertion wrongly reported as a defect (eval F9).
			nodes: [
				{ id: "slow", task: "从 1 慢慢数到 100，每个数字单独一行，不要做任何其他事。" },
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
			edges: [{ id: "a->b", source: "a", target: "b", type: "input", label: "传递上游数字" }],
		};

const events = [];
const ws = await connect();
const mode = CHAT ? "CHAT mode" : PLAN ? "PLAN mode" : ABORT ? "ABORT mode" : "chain mode";
console.log(`connected to ${URL} (${mode})`);

const timeout = setTimeout(() => fail("run did not finish in time"), CHAT ? 480_000 : 240_000);

let aborted = false;
// --- CHAT-mode session tracking -------------------------------------------
// Only trust session events observed AFTER plan_run actually left the wire:
// the hello snapshot replays this server's whole session history, so a
// sentinel from an EARLIER chat run would otherwise satisfy the check
// vacuously. (The snapshot itself is type "hello", never "event".)
let planSent = false;
let injectedNodeCount = null;
let assistantTextAfterInjection = null;
let settledAfterReply = false;
let chatFin = null;

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

ws.onmessage = (msg) => {
	const envelope = JSON.parse(String(msg.data));
	// CHAT: watch the live session stream for the injection + integrated reply.
	if (envelope.type === "event" && CHAT && planSent) {
		const e = envelope.event ?? {};
		if (e.type === "message_end" && e.message?.role === "user") {
			// pi echoes prompts with BLOCK content — textOf normalizes both shapes.
			const text = textOf(e.message);
			if (text.startsWith(SENTINEL)) {
				try {
					injectedNodeCount = JSON.parse(text.split("\n")[1]).nodeCount;
					console.log(`  [chat] results injected into session (${injectedNodeCount} nodes)`);
				} catch {
					fail("injected sentinel message has no parseable meta line");
				}
			}
		}
		if (e.type === "message_end" && e.message?.role === "assistant" && injectedNodeCount !== null) {
			const text = textOf(e.message).trim();
			if (text) assistantTextAfterInjection = text;
		}
		if (e.type === "agent_settled" && assistantTextAfterInjection !== null) settledAfterReply = true;
		return;
	}
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
		if (!CHAT) {
			ws.close();
			finish(e).catch((err) => fail(err.message));
			return;
		}
		// CHAT: PLAN assertions first (same contract), socket STAYS open —
		// the injection + integrated reply are still to come; chatWait polls.
		chatFin = e;
		finish(e).catch((err) => fail(err.message));
	}
};

// Orphan-check baseline: every pi process alive RIGHT BEFORE the run is
// pre-existing (main bridge, other sessions) and excluded from the leak diff.
const baselinePids = listPiPids();

if (PLAN || CHAT) {
	ws.send(JSON.stringify({ type: "plan_run", goal: GOAL, chat: CHAT }));
	planSent = true;
	console.log(`plan_run sent${CHAT ? " (chat: true)" : ""}`);
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

	if (PLAN || CHAT) {
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
		// annotated with a TYPE badge header (输入/参考/审校/修订/汇总/决策).
		if (gen.edges.length > 0) {
			const injected = byType("node_started").some((e) => e.assembledPrompt.includes("## 上游输入"));
			if (!injected) fail("edges exist but no node prompt contains upstream input");
			// STRICTER than validateGraph on purpose: an undefined type passes
			// validation (defaults to input downstream) but fails here — this
			// locks the planner-prompt contract that every edge is explicitly
			// typed, so systematic prompt drift is caught loudly.
			const untyped = gen.edges.filter((e) => typeof e.type !== "string" || !VALID_TYPES.includes(e.type));
			if (untyped.length > 0) {
				fail(`generated edges without a valid type: ${untyped.map((e) => `${e.id}=${JSON.stringify(e.type)}`).join(", ")}`);
			}
			const badgeHeader = byType("node_started").some((e) => /—— (输入|参考|审校|修订|汇总|决策)/.test(e.assembledPrompt));
			if (!badgeHeader) fail("edges exist but no assembledPrompt carries a type-badge header");
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
		// The planner + node bridges must be dead with the run.
		await assertNoLeaks("plan run", baselinePids);
		console.log(`\n  [plan] ok: ${gen.nodes.length} generated nodes ran to completion under one runId`);
		if (!CHAT) {
			console.log("\nE2E OK (plan)");
			process.exit(0);
		}
		// CHAT: the run part passed; the session-agent part is still pending.
		chatWait();
		return;
	}

	if (ABORT) {
		if (fin.status !== "aborted") fail(`expected status "aborted", got "${fin.status}"`);
		// Downstream invariant (relaxed per eval F9): "never" must not COMPLETE
		// — whether it was skipped before starting or aborted in flight depends
		// on when the abort propagated, and both are correct outcomes.
		if (byType("node_completed").some((e) => e.nodeId === "never")) {
			fail("downstream node completed despite the abort");
		}
		const never = ["node_skipped", "node_failed", "node_started"]
			.map((t) => `${t}=${byType(t).filter((e) => e.nodeId === "never").length}`)
			.join(" ");
		await assertNoLeaks("abort", baselinePids);
		console.log(`\nE2E OK (abort): status=aborted, downstream never completed (${never}), no orphaned processes`);
		process.exit(0);
	}

	// --- chain mode ---
	if (fin.status !== "completed") fail(`expected status "completed", got "${fin.status}"`);
	if (fin.ok !== 2 || fin.failed !== 0) fail(`bad counts: ok=${fin.ok} failed=${fin.failed}`);

	const startedB = byType("node_started").find((e) => e.nodeId === "b");
	if (!startedB) fail("node b never started");
	// THE core contract: a's output reached b's prompt.
	if (!startedB.assembledPrompt.includes("7")) fail("b's assembledPrompt does not contain a's output (7)");
	// Typed edge: the badge + optional note annotate the injected section header
	// (full-width parens — same template shared/assemblePrompt renders).
	if (!startedB.assembledPrompt.includes("—— 输入（传递上游数字）")) {
		fail("b's assembledPrompt does not carry the typed-edge badge + note header");
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

/** CHAT tail: poll until injection + integrated reply + settle, then assert. */
function chatWait() {
	const chatTimer = setTimeout(() => fail("chat injection / integrated reply did not arrive in 240s"), 240_000);
	chatTimer.unref?.();
	const poll = setInterval(() => {
		if (injectedNodeCount === null || assistantTextAfterInjection === null || !settledAfterReply) return;
		clearInterval(poll);
		clearTimeout(chatTimer);
		chatAssertions().catch((err) => fail(err.message));
	}, 400);
}

async function chatAssertions() {
	// (a) the injected sentinel carries the FULL set of completed nodes.
	if (injectedNodeCount !== chatFin.ok) {
		fail(`injected meta nodeCount=${injectedNodeCount} but run_finished.ok=${chatFin.ok}`);
	}
	// (b) the session agent produced a non-empty integrated answer.
	if (!assistantTextAfterInjection) fail("no assistant text after injection");
	console.log(`  [chat] integrated reply: ${assistantTextAfterInjection.slice(0, 60)}…`);
	// Refresh replay: a fresh connection's hello carries BOTH the sentinel
	// message (snapshot) and the retained run events.
	const ws2 = await connect();
	const hello = await new Promise((resolve) => {
		ws2.onmessage = (msg) => {
			const envelope = JSON.parse(String(msg.data));
			if (envelope.type === "hello") resolve(envelope);
		};
	});
	ws2.close();
	const snapHasSentinel = (hello.snapshot ?? []).some(
		(ev) => ev.type === "message_end" && ev.message?.role === "user" && textOf(ev.message).startsWith(SENTINEL),
	);
	if (!snapHasSentinel) fail("hello snapshot does not replay the injected sentinel message");
	if (!Array.isArray(hello.run) || hello.run.length !== events.length) {
		fail(`hello replay has ${hello.run?.length} run events, expected ${events.length}`);
	}
	console.log(`  [replay] hello carries sentinel + ${hello.run.length} run events`);
	console.log(`\nE2E OK (chat): injection (${injectedNodeCount} nodes) + integrated reply + replay verified`);
	process.exit(0);
}

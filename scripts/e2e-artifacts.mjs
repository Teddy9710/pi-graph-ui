#!/usr/bin/env node
/**
 * E2E for per-node artifacts directories (`<root>/<runId>/<nodeId>/`) -
 * expects the bridge on :8787 (or WS_URL) running the artifacts code
 * (/health carries artifactsRoot).
 *
 * chain mode (default): a→b run. Node a (no workdir) writes hello.txt from
 * its own cwd - proving the default subprocess cwd IS the node's artifacts
 * dir; node b runs in an explicit workdir (executed there, workdir semantics
 * unchanged) yet its output.md still lands under the artifacts root. Headers,
 * verbatim body, node_started artifactDir wiring, hello replay and
 * pre-feature archives (no artifactDir → UI row hides) are all asserted.
 *
 * ABORT=1: a slow single-node run aborted after its first delta - the
 * artifacts dir exists but holds no output.md (aborted nodes never archive).
 *
 * RERUN=1: an a→bad-agent chain fails on a config error, then rerun_failed
 * seeds a's output.md into the NEW run's dir with a fromRunId header.
 *
 * Usage: node scripts/e2e-artifacts.mjs | ABORT=1 … | RERUN=1 …
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const HTTP = URL.replace(/^ws/, "http");
const ABORT = process.env.ABORT === "1";
const RERUN = process.env.RERUN === "1";
/** Explicit-workdir probe dir, relative to PI_CWD; wiped before AND after. */
const WORKDIR = "e2e-artifacts-wd";

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

const health = await (await fetch(`${HTTP}/health`)).json();
const ROOT = health.artifactsRoot;
if (typeof ROOT !== "string" || !ROOT) fail(`/health carries no artifactsRoot: ${JSON.stringify(health)}`);
const PI_CWD = health.pi.cwd;
console.log(`connected to ${HTTP} (artifacts root: ${ROOT})`);

/** Send one WS message, collect run events until run_finished. */
async function drive(message, opts = {}) {
	const ws = await connect();
	const events = [];
	let aborted = false;
	const timer = setTimeout(() => fail("run did not finish in 240s"), 240_000);
	const done = new Promise((resolve) => {
		ws.onmessage = (msg) => {
			const envelope = JSON.parse(String(msg.data));
			if (envelope.type === "run_error") fail(`run_error: ${envelope.message}`);
			if (envelope.type !== "run_event") return;
			const e = envelope.event;
			events.push(e);
			if (e.type === "node_started") console.log(`  [node] ${e.nodeId} started`);
			if (e.type === "node_completed") console.log(`  [node] ${e.nodeId} ok (${e.durationMs}ms)`);
			if (e.type === "node_failed") console.log(`  [node] ${e.nodeId} FAILED: ${e.error}`);
			if (e.type === "node_delta" && opts.abortOnDelta && !aborted) {
				aborted = true;
				console.log("  [abort] first delta seen - sending abort_run");
				ws.send(JSON.stringify({ type: "abort_run" }));
			}
			if (e.type === "run_finished") {
				clearTimeout(timer);
				ws.close();
				resolve({ events, fin: e });
			}
		};
	});
	ws.send(JSON.stringify(message));
	return done;
}

const runIdOf = (events) => {
	const rs = events.find((e) => e.type === "run_started");
	if (!rs) fail("no run_started event");
	return rs.runId;
};

/** The archived output.md body must be the event text VERBATIM (plus the
 *  trailing newline the format mandates). */
function assertVerbatim(file, text, what) {
	if (!file.endsWith(`---\n\n${text}\n`)) {
		fail(`${what}: output.md body is not the verbatim event text\n--- file tail ---\n${file.slice(-300)}`);
	}
}

if (ABORT) {
	const { events, fin } = await drive(
		{
			type: "run_graph",
			graph: {
				name: "e2e-artifacts-abort",
				nodes: [{ id: "slow", task: "从 1 慢慢数到 100，每个数字单独一行，不要做任何其他事。" }],
				edges: [],
			},
		},
		{ abortOnDelta: true },
	);
	if (fin.status !== "aborted") fail(`expected aborted, got ${fin.status}`);
	const dir = join(ROOT, runIdOf(events), "slow");
	if (!existsSync(dir)) fail(`artifacts dir missing after abort: ${dir}`);
	if (existsSync(join(dir, "output.md"))) fail(`aborted node unexpectedly has an output.md: ${dir}`);
	console.log("\nE2E OK (abort): artifacts dir exists, no output.md for the aborted node");
	process.exit(0);
}

if (RERUN) {
	const graph = {
		name: "e2e-artifacts-rerun",
		nodes: [
			{ id: "a", label: "稳定节点", task: "只输出数字 7，不要任何其他文字。" },
			{ id: "bad", agent: "no-such-persona-e2e", task: "只输出 ok" },
		],
		edges: [{ id: "a->bad", source: "a", target: "bad" }],
	};
	const first = await drive({ type: "run_graph", graph });
	if (first.fin.status !== "failed") fail(`expected the first run to fail, got ${first.fin.status}`);
	const oldRunId = runIdOf(first.events);

	const second = await drive({ type: "rerun_failed", runId: oldRunId });
	const newRunId = runIdOf(second.events);
	if (newRunId === oldRunId) fail("rerun did not mint a fresh runId");

	// a is seeded (node_reused) with the NEW run's dir + the old run's origin.
	const reused = second.events.find((e) => e.type === "node_reused" && e.nodeId === "a");
	if (!reused) fail("no node_reused for a in the rerun");
	if (reused.artifactDir !== join(ROOT, newRunId, "a")) {
		fail(`reused artifactDir ${reused.artifactDir} != ${join(ROOT, newRunId, "a")}`);
	}
	if (reused.fromRunId !== oldRunId) fail(`reused fromRunId ${reused.fromRunId} != ${oldRunId}`);
	const fileA = readFileSync(join(ROOT, newRunId, "a", "output.md"), "utf8");
	if (!fileA.includes(`fromRunId: ${oldRunId}`) || !fileA.includes(`runId: ${newRunId}`)) {
		fail(`rerun seed output.md misses headers:\n${fileA}`);
	}
	assertVerbatim(fileA, reused.output.text, "rerun a");
	console.log("\nE2E OK (rerun): seed archived under the new runId with a fromRunId header");
	process.exit(0);
}

// --- chain mode ---
rmSync(join(PI_CWD, WORKDIR), { recursive: true, force: true }); // stale leftovers from an older attempt
const graph = {
	name: "e2e-artifacts",
	nodes: [
		{ id: "a", label: "落盘节点", task: "用写文件工具在当前工作目录创建 hello.txt，内容只有数字 7。然后只输出数字 7，不要任何其他文字。" },
		{
			id: "b",
			label: "加一节点",
			workdir: WORKDIR,
			task: "上游输入里有一个数字 N。用写文件工具在当前工作目录创建 result.txt，内容只有 N 加 1 的结果数字。然后只输出这个结果数字，不要任何其他文字。",
		},
	],
	edges: [{ id: "a->b", source: "a", target: "b", type: "input" }],
};
try {
	const { events, fin } = await drive({ type: "run_graph", graph });
	if (fin.status !== "completed" || fin.ok !== 2) fail(`bad finish: ${JSON.stringify(fin)}`);
	const runId = runIdOf(events);

	// Every started node announced its artifacts dir.
	for (const e of events.filter((x) => x.type === "node_started")) {
		if (e.artifactDir !== join(ROOT, runId, e.nodeId)) {
			fail(`node_started ${e.nodeId}: artifactDir ${e.artifactDir} != ${join(ROOT, runId, e.nodeId)}`);
		}
	}

	// Default cwd: a (no workdir) wrote hello.txt INTO its artifacts dir.
	const helloFile = join(ROOT, runId, "a", "hello.txt");
	if (!existsSync(helloFile)) fail(`a wrote no hello.txt in its artifacts dir (${helloFile}) - default cwd is not the artifacts dir`);
	if (!/^\s*7\s*$/.test(readFileSync(helloFile, "utf8"))) {
		fail(`hello.txt content is not 7: ${JSON.stringify(readFileSync(helloFile, "utf8"))}`);
	}
	console.log("  [cwd] a wrote hello.txt inside its artifacts dir (default cwd verified)");

	// Explicit workdir: b executed THERE (its result.txt), precedence unchanged.
	const resultFile = join(PI_CWD, WORKDIR, "result.txt");
	if (!existsSync(resultFile)) fail(`b wrote no result.txt in the explicit workdir (${resultFile})`);
	console.log("  [workdir] b executed in the explicit workdir (result.txt present)");

	// output.md: headers + verbatim body for BOTH nodes (workdir node included).
	const textOf = (id) => {
		const c = events.find((x) => x.type === "node_completed" && x.nodeId === id);
		if (!c) fail(`node ${id} never completed`);
		return c.output.text;
	};
	const fileA = readFileSync(join(ROOT, runId, "a", "output.md"), "utf8");
	for (const line of [`runId: ${runId}`, "nodeId: a", "label: 落盘节点", "model: ", "endedAt: ", "durationMs: "]) {
		if (!fileA.includes(line)) fail(`a/output.md misses header "${line}":\n${fileA}`);
	}
	assertVerbatim(fileA, textOf("a"), "a");
	const fileB = readFileSync(join(ROOT, runId, "b", "output.md"), "utf8");
	if (!fileB.includes("nodeId: b") || !fileB.includes("label: 加一节点")) fail(`b/output.md misses headers:\n${fileB}`);
	assertVerbatim(fileB, textOf("b"), "b");
	console.log("  [archive] output.md headers + verbatim body verified for a and b");

	// Hello replay keeps artifactDir (the browser-refresh path feeds the UI row).
	const ws2 = await connect();
	const hello = await new Promise((resolve) => {
		ws2.onmessage = (msg) => {
			const envelope = JSON.parse(String(msg.data));
			if (envelope.type === "hello") resolve(envelope);
		};
	});
	ws2.close();
	if (runIdOf(hello.run ?? []) !== runId) fail("hello replay is not the just-finished run");
	const replayed = (hello.run ?? []).filter((e) => e.type === "node_started");
	if (!replayed.every((e) => e.artifactDir === join(ROOT, runId, e.nodeId))) {
		fail("hello replay lost the node_started artifactDir fields");
	}
	console.log(`  [replay] hello carries ${hello.run.length} run events with artifactDir intact`);

	// Pre-feature archives carry NO artifactDir → the UI row hides for them.
	const runs = await (await fetch(`${HTTP}/api/runs`)).json();
	for (let i = runs.length - 1; i >= 0; i--) {
		const evs = await (await fetch(`${HTTP}/api/runs/${runs[i].id}`)).json();
		const sts = evs.filter((e) => e.type === "node_started");
		if (sts.length === 0) continue;
		if (sts.some((e) => "artifactDir" in e)) fail(`old archive ${runs[i].id} unexpectedly carries artifactDir`);
		console.log(`  [old-archive] ${runs[i].id}: no artifactDir (UI row hidden for pre-feature runs)`);
		break;
	}

	console.log("\nE2E OK (chain): default cwd, workdir precedence, output.md archive, replay, old-archive compat");
} finally {
	rmSync(join(PI_CWD, WORKDIR), { recursive: true, force: true });
}
process.exit(0);

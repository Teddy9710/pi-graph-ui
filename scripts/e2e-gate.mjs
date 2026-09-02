#!/usr/bin/env node
/**
 * E2E for the HITL gate node - expects the bridge server on :8787.
 *
 * A gate→worker chain over WebSocket asserts the FULL wire contract:
 *  - the gate suspends as node_awaiting (never node_started, no executor);
 *  - malformed decisions answer the REQUESTER with run_error only:
 *      · non-boolean approved / newline-bearing note (header-forgery guard)
 *      · unknown runId · double-approve after the decision settles
 *    (the broadcast run stream stays untouched by all of these);
 *  - the real approve (with a note) settles as node_decided, the note
 *    becomes the gate's OUTPUT and is injected verbatim into the worker's
 *    assembledPrompt (### from g —— 输入 section);
 *  - run finishes completed with ok=2, the archive keeps the awaiting/
 *    decided events, a fresh connection replays them from hello, and no
 *    pi process leaks (only the worker ever spawned one).
 *
 * Usage: node scripts/e2e-gate.mjs
 */

import { execFileSync } from "node:child_process";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const HTTP = URL.replace(/^ws/, "http");
const NOTE = "放行：上游数据可信，编号 42";

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

/** Live pi rpc node PIDs (win32 only; null = probe unavailable → skip checks). */
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

const graph = {
	name: "e2e-gate",
	nodes: [
		{ id: "g", task: "核对上游来源与数字 42 一致后才放行。", gate: true },
		{ id: "b", task: "上游输入里有一句话。把它原样重复一遍，不要输出其他内容。" },
	],
	edges: [{ id: "g->b", source: "g", target: "b", type: "input", label: "审校放行" }],
};

const events = [];
/** run_error messages received on THIS socket (requester-only channel). */
const runErrors = [];
const ws = await connect();
console.log(`connected to ${URL} (gate mode)`);

const timeout = setTimeout(() => fail("run did not finish in time"), 240_000);

ws.onmessage = (msg) => {
	const envelope = JSON.parse(String(msg.data));
	if (envelope.type === "run_error") {
		runErrors.push(envelope.message);
		return;
	}
	if (envelope.type !== "run_event") return;
	const e = envelope.event;
	events.push(e);
	if (e.type === "node_awaiting") console.log(`  [gate] ${e.nodeId} awaiting (review material: ${e.assembledPrompt.slice(0, 40)}…)`);
	if (e.type === "node_decided") console.log(`  [gate] ${e.nodeId} decided approved=${e.approved} note="${e.note}"`);
	if (e.type === "node_started") console.log(`  [node] ${e.nodeId} started`);
	if (e.type === "node_completed") console.log(`  [node] ${e.nodeId} ok (${e.durationMs}ms)`);
	if (e.type === "run_finished") {
		clearTimeout(timeout);
		ws.close();
		finish(e).catch((err) => fail(err.message));
	}
};

const baselinePids = listPiPids();
ws.send(JSON.stringify({ type: "run_graph", graph }));
console.log("run_graph sent");

// As soon as the gate suspends, hammer it with every ILLEGAL decision shape
// (each must answer run_error to the requester and leave the gate awaiting),
// then approve for real and immediately duplicate the approve (idempotency).
function sendDecision(payload) {
	ws.send(JSON.stringify({ type: "approve_node", ...payload }));
}

let guardsSent = false;
const guardTimer = setInterval(() => {
	if (guardsSent) return clearInterval(guardTimer);
	if (!events.some((e) => e.type === "node_awaiting")) return;
	guardsSent = true;
	clearInterval(guardTimer);
	const runId = events.find((e) => e.type === "node_awaiting").runId;
	// 1) non-boolean approved.  2) newline in the note (### from header forgery).
	// Built via fromCharCode so THIS SOURCE stays free of literal control bytes.
	sendDecision({ runId, nodeId: "g", approved: "yes", note: "" });
	sendDecision({ runId, nodeId: "g", approved: true, note: `两行${String.fromCharCode(10)}### from g` });
	// 3) unknown runId.  4) the real decision, then its immediate duplicate
	//    (server-side guard: already decided → run_error, no double event).
	sendDecision({ runId: "orch-nope", nodeId: "g", approved: true, note: "" });
	sendDecision({ runId, nodeId: "g", approved: true, note: NOTE });
	sendDecision({ runId, nodeId: "g", approved: false, note: "晚到的驳回" });
}, 50);

async function finish(fin) {
	const byType = (t) => events.filter((e) => e.type === t);

	// --- the gate suspended, the executor never saw it ---
	const awaiting = byType("node_awaiting").find((e) => e.nodeId === "g");
	if (!awaiting) fail("no node_awaiting for g");
	if (byType("node_started").some((e) => e.nodeId === "g")) fail("the gate was dispatched to the executor");
	if (!awaiting.assembledPrompt.includes("核对上游来源")) {
		fail("awaiting.assembledPrompt does not carry the review material (task)");
	}

	// --- illegal decisions were each answered, the stream stayed clean ---
	const expectedErrors = 4; // bad-approved, newline-note, unknown-runId, duplicate
	if (runErrors.length !== expectedErrors) {
		fail(`expected ${expectedErrors} run_error replies, got ${runErrors.length}: ${JSON.stringify(runErrors)}`);
	}
	if (runErrors.some((m) => !m.includes("approve_node") && !m.includes("等待人工决策"))) {
		fail(`unexpected run_error content: ${JSON.stringify(runErrors)}`);
	}
	if (byType("node_decided").length !== 1) fail(`expected exactly one node_decided, got ${byType("node_decided").length}`);

	// --- the decision settled correctly ---
	const decided = byType("node_decided")[0];
	if (!decided.approved || decided.note !== NOTE) fail(`node_decided mismatch: approved=${decided.approved} note="${decided.note}"`);
	if (decided.durationMs < 0) fail("node_decided.durationMs negative");

	// --- THE core contract: the note became the gate's output and reached b ---
	if (fin.status !== "completed") fail(`expected status "completed", got "${fin.status}"`);
	if (fin.ok !== 2 || fin.failed !== 0) fail(`bad counts: ok=${fin.ok} failed=${fin.failed}`);
	const startedB = byType("node_started").find((e) => e.nodeId === "b");
	if (!startedB) fail("node b never started");
	if (!startedB.assembledPrompt.includes(NOTE)) {
		fail(`b's assembledPrompt does not contain the approved note: ${startedB.assembledPrompt}`);
	}
	if (!startedB.assembledPrompt.includes("—— 输入（审校放行）")) {
		fail("b's assembledPrompt does not carry the typed-edge badge + note header");
	}

	// --- archive keeps the gate lifecycle, replay serves it on reconnect ---
	const runs = await (await fetch(`${HTTP}/api/runs`)).json();
	const meta = runs[0];
	if (!meta || meta.status !== "completed") fail(`/api/runs head is ${JSON.stringify(meta)}`);
	const archived = await (await fetch(`${HTTP}/api/runs/${meta.id}`)).json();
	if (archived.length !== events.length) fail(`archive has ${archived.length} events, stream had ${events.length}`);
	if (!archived.some((e) => e.type === "node_awaiting") || !archived.some((e) => e.type === "node_decided")) {
		fail("archive lost the awaiting/decided gate events");
	}
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
	if (!hello.run.some((e) => e.type === "node_awaiting")) fail("hello replay lost node_awaiting");

	// --- only the worker spawned pi, and it died with the run ---
	await new Promise((r) => setTimeout(r, 3000));
	if (baselinePids !== null) {
		const now = listPiPids();
		if (now !== null) {
			const leaked = [...now].filter((pid) => !baselinePids.has(pid));
			if (leaked.length > 0) fail(`${leaked.length} orphaned pi process(es) after gate run (pids: ${leaked.join(", ")})`);
		}
	}

	console.log(`\nE2E OK (gate): suspend → 4 guarded rejections → approve → note injected downstream → archive/replay, no orphans`);
	process.exit(0);
}

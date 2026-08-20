#!/usr/bin/env node
/**
 * E2E smoke test: start nothing - expects the bridge server on :8787.
 * Connects over WebSocket, sends a small prompt that triggers one tool call,
 * folds the event stream with @pi-graph/shared, and prints the derived graph.
 *
 * Usage: node scripts/e2e-smoke.mjs [prompt]
 */

import { deriveGraph, foldEvent, initState } from "../packages/shared/src/index.ts";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const PROMPT = process.argv[2] ?? "用 bash 执行 echo pi-graph-e2e 然后把输出原样告诉我。不要做其他事。";

const state = initState();
let settled = false;

const ws = new WebSocket(URL);
const timeout = setTimeout(() => {
	console.error("TIMEOUT: agent did not settle in 120s");
	process.exit(1);
}, 120000);

ws.onopen = () => {
	console.log(`connected to ${URL}`);
	ws.send(JSON.stringify({ type: "command", command: { type: "prompt", message: PROMPT } }));
	console.log("prompt sent, streaming events...");
};

ws.onmessage = (msg) => {
	const envelope = JSON.parse(String(msg.data));
	if (envelope.type === "event") {
		foldEvent(state, envelope.event);
		const e = envelope.event;
		if (e.type === "tool_execution_start") console.log(`  [tool] ${e.toolName} running...`);
		if (e.type === "tool_execution_end") console.log(`  [tool] ${e.toolName} ${e.isError ? "ERROR" : "ok"}`);
		if (e.type === "agent_settled") {
			settled = true;
			clearTimeout(timeout);
			report();
		}
	}
};

ws.onerror = (err) => {
	console.error("WS error:", err.message ?? err);
	process.exit(1);
};

function report() {
	const graph = deriveGraph(state);
	console.log("\n=== session state ===");
	console.log(`messages: ${state.messages.length}, tools: ${state.tools.size}, status: ${state.agentStatus}`);
	console.log(`usage: in=${state.usageTotal.input} out=${state.usageTotal.output} total=${state.usageTotal.totalTokens}`);
	console.log("\n=== graph ===");
	for (const n of graph.nodes) {
		console.log(`  ${n.id}  [${n.data.kind}/${n.data.status}] ${n.data.label.slice(0, 60)}`);
	}
	console.log(`edges: ${graph.edges.length}`);
	const badEdges = graph.edges.filter(
		(e) => !graph.nodes.some((n) => n.id === e.source) || !graph.nodes.some((n) => n.id === e.target),
	);
	if (badEdges.length > 0) {
		console.error("DANGLING EDGES:", badEdges);
		process.exit(1);
	}
	const nodeIds = graph.nodes.map((n) => n.id);
	if (new Set(nodeIds).size !== nodeIds.length) {
		console.error("DUPLICATE NODE IDS");
		process.exit(1);
	}
	console.log(settled ? "\nE2E OK" : "\nE2E INCOMPLETE (agent did not settle)");
	ws.close();
	process.exit(settled ? 0 : 1);
}

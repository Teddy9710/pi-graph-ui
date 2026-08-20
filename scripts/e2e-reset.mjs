#!/usr/bin/env node
/**
 * E2E test for the new-session reset flow:
 * prompt -> graph grows -> new_session -> graph empties -> prompt works again.
 * Expects the bridge server on :8787.
 */

import { deriveGraph, foldEvent, initState } from "../packages/shared/src/index.ts";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const state = initState();
let phase = "prompt1";
let settled = 0;

const ws = new WebSocket(URL);
const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	process.exit(1);
}, 180000);

function sendPrompt(msg) {
	ws.send(JSON.stringify({ type: "command", command: { type: "prompt", message: msg } }));
}

function nodeCount() {
	return deriveGraph(state).nodes.length;
}

function resetLocal() {
	// Mirror what the browser does on reset: rebuild from scratch.
	Object.assign(state, initState());
}

ws.onopen = () => {
	console.log("connected");
	sendPrompt("用 bash 执行 echo reset-test-1 然后告诉我输出");
};

ws.onmessage = (msg) => {
	const envelope = JSON.parse(String(msg.data));
	if (envelope.type === "event") {
		foldEvent(state, envelope.event);
		if (envelope.event.type === "agent_settled") {
			settled++;
			if (phase === "prompt1") {
				const count = nodeCount();
				console.log(`phase1 graph nodes: ${count} (expect > 3)`);
				if (count < 4) {
					console.error("FAIL: graph too small before reset");
					process.exit(1);
				}
				phase = "reset";
				resetLocal();
				ws.send(JSON.stringify({ type: "command", command: { type: "new_session" } }));
			} else if (phase === "prompt2") {
				const count = nodeCount();
				console.log(`phase2 graph nodes after new session: ${count} (expect >= 3, fresh graph)`);
				clearTimeout(timeout);
				console.log(count >= 3 ? "\nRESET E2E OK" : "\nRESET E2E FAIL");
				ws.close();
				process.exit(count >= 3 ? 0 : 1);
			}
		}
	}
	if (envelope.type === "reset" && phase === "reset") {
		console.log("got reset marker, history cleared; sending fresh prompt");
		phase = "prompt2";
		resetLocal();
		sendPrompt("用 bash 执行 echo reset-test-2 然后告诉我输出");
	}
};

ws.onerror = (e) => {
	console.error("WS error", e.message ?? e);
	process.exit(1);
};

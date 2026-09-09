#!/usr/bin/env node
/**
 * E2E test for multi-session management (对话管理):
 *   hello carries sessionId → prompt A (我叫小明) → settle → archive A is
 *   resumable → new_session (hello sessionId=null) → prompt B (1+1) → settle →
 *   switch_session A (hello sessionId=A, snapshot rebuilt) → ask 我叫什么名字 →
 *   the answer MUST contain 小明 (context really came back — the golden
 *   assertion) → PATCH rename → DELETE B (204) → DELETE A while active (409).
 * Expects the bridge server on :8787 and a REAL model behind pi.
 */

import { foldEvent, initState } from "../packages/shared/src/index.ts";

const URL = process.env.WS_URL ?? "ws://localhost:8787";
const API = process.env.API_URL ?? "http://localhost:8787";

const state = initState();
let phase = "connect";
let settledCount = 0;
/** Resolves on the NEXT hello envelope; captures its sessionId + snapshot. */
let helloWait = null;

const ws = new WebSocket(URL);
const timeout = setTimeout(() => {
	console.error(`TIMEOUT in phase ${phase}`);
	process.exit(1);
}, 300000);

function resetLocal() {
	Object.assign(state, initState());
}

function assistantTexts() {
	return state.messages
		.filter((m) => m.role === "assistant")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("")))
		.join("\n");
}

function sendPrompt(message) {
	ws.send(JSON.stringify({ type: "command", command: { type: "prompt", message } }));
}

function nextHello() {
	return new Promise((resolve) => {
		helloWait = resolve;
	});
}

async function sessionsList() {
	const res = await fetch(`${API}/api/sessions`);
	if (!res.ok) throw new Error(`GET /api/sessions -> HTTP ${res.status}`);
	return res.json();
}

async function deleteSession(id) {
	const res = await fetch(`${API}/api/sessions/${id}`, { method: "DELETE" });
	return res.status;
}

ws.onopen = () => {
	console.log("connected");
};

ws.onmessage = async (msg) => {
	const envelope = JSON.parse(String(msg.data));
	if (envelope.type === "hello" && helloWait) {
		const wait = helloWait;
		helloWait = null;
		wait({ sessionId: envelope.sessionId ?? null, snapshot: envelope.snapshot ?? [] });
		return;
	}
	if (envelope.type === "event") {
		foldEvent(state, envelope.event);
		if (envelope.event.type === "agent_settled") {
			settledCount++;
			try {
				await onSettled();
			} catch (err) {
				console.error("FAIL:", err.message);
				process.exit(1);
			}
		}
	}
	if (envelope.type === "error") {
		console.error("FAIL: server error envelope:", envelope.message);
		process.exit(1);
	}
};

ws.onerror = (e) => {
	console.error("WS error", e.message ?? e);
	process.exit(1);
};

async function onSettled() {
	if (phase === "promptA") {
		// A finished: its archive must exist and be resumable.
		const list = await sessionsList();
		const a = list.find((s) => (s.firstUserText ?? "").includes("我叫小明"));
		if (!a) throw new Error(`archive A not found in list (${list.length} sessions)`);
		if (!a.resumable) throw new Error("archive A is not resumable (pi session file missing?)");
		console.log(`phase A settled: archive ${a.id} resumable, ${a.eventCount} events`);

		// ＋新对话: fresh world, hello must say sessionId=null.
		phase = "new";
		resetLocal();
		ws.send(JSON.stringify({ type: "command", command: { type: "new_session" } }));
		const hello = await nextHello();
		if (hello.sessionId !== null) throw new Error(`expected sessionId null after new_session, got ${hello.sessionId}`);
		if (hello.snapshot.length !== 0) throw new Error(`expected empty snapshot after new_session, got ${hello.snapshot.length}`);
		console.log("new_session ok: fresh hello, sessionId=null");
		phase = "promptB";
		sendPrompt("1+1 等于几？只回答数字");
		return;
	}

	if (phase === "promptB") {
		const list = await sessionsList();
		const b = list.find((s) => (s.firstUserText ?? "").includes("1+1"));
		if (!b) throw new Error("archive B not found in list");
		console.log(`phase B settled: archive ${b.id}`);

		// Switch back to A: hello must rebuild the world from A's archive.
		const a = list.find((s) => (s.firstUserText ?? "").includes("我叫小明"));
		phase = "switch";
		ws.send(JSON.stringify({ type: "switch_session", id: a.id }));
		const hello = await nextHello();
		if (hello.sessionId !== a.id) throw new Error(`expected hello.sessionId=${a.id}, got ${hello.sessionId}`);
		resetLocal();
		for (const e of hello.snapshot) foldEvent(state, e);
		const texts = JSON.stringify(assistantTexts());
		if (!(await snapshotHasXiaoMing())) throw new Error("switched snapshot has no 小明 conversation");
		console.log(`switch ok: hello sessionId=${a.id}, ${hello.snapshot.length} events rebuilt`);

		// The golden assertion: pi's CONTEXT must have come back too.
		phase = "promptA2";
		sendPrompt("我叫什么名字？只回答名字本身");
		return;
	}

	if (phase === "promptA2") {
		const answer = assistantTexts();
		if (!answer.includes("小明")) {
			throw new Error(`context was NOT restored — last answer: ${answer.slice(-200)}`);
		}
		console.log("context restored: the answer mentions 小明");

		// Rename A, then delete B (204) and A-while-active (409).
		const list = await sessionsList();
		const a = list.find((s) => (s.firstUserText ?? "").includes("我叫小明"));
		const b = list.find((s) => (s.firstUserText ?? "").includes("1+1"));
		const patch = await fetch(`${API}/api/sessions/${a.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "小明的自我介绍" }),
		});
		if (patch.status !== 200) throw new Error(`PATCH rename -> HTTP ${patch.status}`);
		const renamed = (await sessionsList()).find((s) => s.id === a.id);
		if (renamed.title !== "小明的自我介绍") throw new Error(`rename not persisted: ${renamed.title}`);
		console.log("rename ok");

		if ((await deleteSession(b.id)) !== 204) throw new Error("DELETE B did not return 204");
		if ((await deleteSession(a.id)) !== 409) throw new Error("DELETE active A did not return 409");
		console.log("delete ok: B=204, active A=409");

		clearTimeout(timeout);
		console.log("\nSESSIONS E2E OK");
		ws.close();
		process.exit(0);
	}
}

async function snapshotHasXiaoMing() {
	return state.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("我叫小明"));
}

// Kick off once the socket opens: the connect hello lands first.
ws.addEventListener("open", async () => {
	const hello = await nextHello();
	console.log(`connect hello: sessionId=${hello.sessionId ?? "null"}, ${hello.snapshot.length} events`);
	phase = "promptA";
	sendPrompt("请记住：我叫小明。只回复「好的」两个字。");
});

/**
 * SessionService tests — the switch/new/remove lifecycle against a scripted
 * fake bridge, a REAL EventHub and a REAL SessionStore (tmpdir): these are
 * the ordering guarantees main.ts cannot unit-test inline.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	foldEvent,
	initState,
	type JsonAgentSessionEvent,
	type RpcCommand,
	type RpcResponse,
} from "@pi-graph/shared";
import { EventHub } from "../src/event-hub.ts";
import { SessionStore } from "../src/session-store.ts";
import { SessionService, type SessionServiceDeps } from "../src/session-service.ts";

/** Cast helper: tests only exercise the fields the fold/store read. */
const ev = (e: unknown) => e as JsonAgentSessionEvent;

const userEnd = ev({
	type: "message_end",
	message: { role: "user", content: [{ type: "text", text: "我叫小明" }] },
});
const assistantEnd = ev({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "你好！" }],
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
	},
});

/** A legal archive id shape (same pattern append() generates). */
const ID_LIKE = "2026-09-05T01-02-03-004Z";

/** Scripted bridge: queued replies (or thrown Errors), recorded calls, plus a
 *  synchronous onRequest hook so tests can emit straggler events mid-switch. */
class FakeBridge {
	calls: RpcCommand[] = [];
	private queue: Array<RpcResponse | Error> = [];
	onRequest: ((cmd: RpcCommand) => void) | null = null;

	scripted(responses: Array<RpcResponse | Error>): void {
		this.queue.push(...responses);
	}

	async request(command: RpcCommand): Promise<RpcResponse> {
		this.calls.push(command);
		this.onRequest?.(command);
		const next = this.queue.shift();
		if (next instanceof Error) throw next;
		return next ?? { id: "auto", type: "response", command: command.type, success: true, data: {} };
	}
}

const resp = (command: string, data?: unknown, success = true): RpcResponse => ({
	id: "x",
	type: "response",
	command,
	success,
	data,
});

interface Broadcast {
	type: string;
	sessionId?: string | null;
	snapshot?: JsonAgentSessionEvent[];
}

const dirs: string[] = [];
function harness(opts: { agentBusy?: boolean; runBusy?: boolean } = {}) {
	const bridge = new FakeBridge();
	const hub = new EventHub({ intervalMs: 0 });
	const dir = mkdtempSync(join(tmpdir(), "pi-graph-service-"));
	dirs.push(dir);
	const store = new SessionStore(dir);
	let folded = initState();
	const broadcasts: Broadcast[] = [];
	const errors: string[] = [];
	const delivered: string[] = [];
	// Mutable so a single harness can flip busy mid-test.
	const flags = { agentBusy: opts.agentBusy ?? false, runBusy: opts.runBusy ?? false };
	const service = new SessionService({
		bridge,
		hub,
		store,
		isAgentBusy: () => flags.agentBusy,
		isRunBusy: () => flags.runBusy,
		applySession: (next) => {
			folded = next;
		},
		broadcast: (payload) => broadcasts.push(payload as Broadcast),
		replyError: (_ws, message) => errors.push(message),
		retainedRunEvents: () => [],
		deliverEvent: (event) => {
			foldEvent(folded, event);
			hub.ingest(event);
			store.append(event);
			delivered.push(event.type);
		},
	});
	return {
		bridge,
		hub,
		store,
		service,
		flags,
		broadcasts,
		errors,
		delivered,
		get folded() {
			return folded;
		},
	};
}

afterEach(() => {
	while (dirs.length) {
		try {
			rmSync(dirs.pop()!, { recursive: true, force: true });
		} catch {
			/* Windows may lag on handle release */
		}
	}
});

/** Build a resumable target archive: events on disk + index entry + pi file,
 *  then finalize so it is NOT the current session anymore. */
async function seedTarget(h: ReturnType<typeof harness>, events: JsonAgentSessionEvent[]) {
	for (const e of events) h.store.append(e);
	const id = h.store.currentId!;
	h.store.finalize();
	const piFile = join(h.store.dir, `${id}.pi.jsonl`);
	writeFileSync(piFile, "{}");
	h.store.bindPiSession(id, piFile);
	return { id, piFile };
}

describe("SessionService.switchTo", () => {
	it("rebuilds from the archive, forces idle, broadcasts exactly one hello", async () => {
		const h = harness();
		// Archive ends mid-turn: agent_start with no agent_settled — a server
		// crash mid-run would leave exactly this dangling "running" state.
		const { id, piFile } = await seedTarget(h, [userEnd, ev({ type: "agent_start" })]);
		const raw = initState();
		for (const e of await h.store.read(id)) foldEvent(raw, e);
		expect(raw.agentStatus).toBe("running"); // sanity: the fold really dangles

		h.bridge.scripted([
			resp("get_state", { sessionId: "s-old", sessionFile: null, isStreaming: false }),
			resp("switch_session", { ok: true }),
			resp("get_state", { sessionId: "s-new", sessionFile: piFile, isStreaming: false }),
		]);
		await h.service.switchTo(undefined, id);

		expect(h.errors).toEqual([]);
		expect(h.bridge.calls.map((c) => c.type)).toEqual(["get_state", "switch_session", "get_state"]);
		expect((h.bridge.calls[1] as { sessionPath: string }).sessionPath).toBe(piFile);

		const hellos = h.broadcasts.filter((p) => p.type === "hello");
		expect(hellos).toHaveLength(1);
		expect(hellos[0].sessionId).toBe(id);
		expect(hellos[0].snapshot).toHaveLength(2);

		// The hub replay is the new world; the archive continues under the id.
		expect(h.hub.history()).toHaveLength(2);
		expect(h.store.currentId).toBe(id);
		// Dangling running forced idle; the transcript really came back.
		expect(h.folded.agentStatus).toBe("idle");
		expect(h.folded.messages).toHaveLength(1);
		expect(h.service.currentPiFile).toBe(piFile);
		expect(h.service.busy).toBe(false);
	});

	it("appends events that arrive mid-switch to the new snapshot (buffered)", async () => {
		const h = harness();
		const { id, piFile } = await seedTarget(h, [userEnd]);
		h.bridge.onRequest = (cmd) => {
			if (cmd.type === "switch_session") h.service.handleEvent(assistantEnd); // straggler
		};
		h.bridge.scripted([
			resp("get_state", { isStreaming: false }),
			resp("switch_session", {}),
			resp("get_state", { sessionFile: piFile }),
		]);
		await h.service.switchTo(undefined, id);

		// The straggler never hit the OLD deliver path…
		expect(h.delivered).toEqual([]);
		// …but it joined the new world: archive + straggler in one hello.
		const hello = h.broadcasts.find((p) => p.type === "hello");
		expect(hello?.snapshot).toHaveLength(2);
		expect(h.hub.history()).toHaveLength(2);
		expect(h.folded.messages).toHaveLength(2);
	});

	it("switch does not re-bind the outgoing archive to the target's pi file", async () => {
		const h = harness();
		const { id, piFile } = await seedTarget(h, [userEnd]);

		// A live outgoing session, bound to its OWN pi file.
		const outgoingFile = join(h.store.dir, "pi-out.jsonl");
		writeFileSync(outgoingFile, "{}");
		h.bridge.scripted([resp("get_state", { sessionFile: outgoingFile, isStreaming: false })]);
		await h.service.refreshPiSession();
		h.service.handleEvent(userEnd); // outgoing archive born (probe auto-answers {})
		const outgoingId = h.store.currentId!;
		expect(h.store.getEntry(outgoingId)?.piSessionPath).toBe(outgoingFile);

		// Switch away. The post-switch refresh runs BEFORE store.resume(id) —
		// a bare refresh there would bind currentId (= the OUTGOING id) to
		// the target's file; both archives would then resume the same pi
		// context (the double-binding bug).
		h.bridge.scripted([
			resp("get_state", { isStreaming: false }),
			resp("switch_session", {}),
			resp("get_state", { sessionFile: piFile }),
		]);
		await h.service.switchTo(undefined, id);

		expect(h.store.getEntry(outgoingId)?.piSessionPath).toBe(outgoingFile); // untouched
		expect(h.store.getEntry(id)?.piSessionPath).toBe(piFile);
	});

	it("refuses before touching pi on every guard", async () => {
		// Illegal id.
		const h1 = harness();
		await h1.service.switchTo(undefined, "../evil");
		expect(h1.errors[0]).toContain("非法");
		expect(h1.bridge.calls).toHaveLength(0);

		// Already the current session.
		const h2 = harness();
		h2.store.append(userEnd);
		await h2.service.switchTo(undefined, h2.store.currentId!);
		expect(h2.errors[0]).toContain("已是当前会话");

		// Orchestration / agent busy.
		const h3 = harness();
		const t3 = await seedTarget(h3, [userEnd]);
		h3.flags.runBusy = true;
		await h3.service.switchTo(undefined, t3.id);
		expect(h3.errors[0]).toContain("编排");
		const h4 = harness();
		const t4 = await seedTarget(h4, [userEnd]);
		h4.flags.agentBusy = true;
		await h4.service.switchTo(undefined, t4.id);
		expect(h4.errors[0]).toContain("agent");

		// No pi session mapping (read-only archive).
		const h5 = harness();
		h5.store.append(userEnd);
		const id5 = h5.store.currentId!;
		h5.store.finalize();
		await h5.service.switchTo(undefined, id5);
		expect(h5.errors[0]).toContain("没有对应的 pi 会话文件");

		// Mapping exists but the file is gone (pi never flushed / user wiped it).
		const h6 = harness();
		const t6 = await seedTarget(h6, [userEnd]);
		rmSync(t6.piFile);
		await h6.service.switchTo(undefined, t6.id);
		expect(h6.errors[0]).toContain("已不存在");

		// Empty archive (id parses, file empty).
		const h7 = harness();
		writeFileSync(join(h7.store.dir, `${ID_LIKE}.jsonl`), "");
		const pi7 = join(h7.store.dir, "pi.jsonl");
		writeFileSync(pi7, "{}");
		h7.store.bindPiSession(ID_LIKE, pi7);
		await h7.service.switchTo(undefined, ID_LIKE);
		expect(h7.errors[0]).toContain("归档");

		// All guards answered the requester without a bridge round-trip.
		for (const h of [h1, h2, h3, h4, h5, h6, h7]) {
			expect(h.broadcasts.filter((p) => p.type === "hello")).toHaveLength(0);
			expect(h.service.busy).toBe(false);
		}
	});

	it("refuses when the streaming double-check fails, and never half-switches", async () => {
		const h = harness();
		const { id } = await seedTarget(h, [userEnd]);
		h.bridge.scripted([resp("get_state", { isStreaming: true })]);
		await h.service.switchTo(undefined, id);
		expect(h.errors[0]).toContain("仍在输出");
		expect(h.bridge.calls.map((c) => c.type)).toEqual(["get_state"]); // no switch_session sent
		expect(h.broadcasts).toHaveLength(0);

		const h2 = harness();
		const t2 = await seedTarget(h2, [userEnd]);
		h2.bridge.scripted([resp("get_state", undefined, false)]);
		await h2.service.switchTo(undefined, t2.id);
		expect(h2.errors[0]).toContain("无法确认");
	});

	it("rolls the buffer back to the live path when pi refuses the switch", async () => {
		const h = harness();
		const { id } = await seedTarget(h, [userEnd]);
		h.bridge.scripted([
			resp("get_state", { isStreaming: false }),
			resp("switch_session", undefined, false),
		]);
		await h.service.switchTo(undefined, id);
		expect(h.errors[0]).toContain("切换会话失败");
		expect(h.broadcasts.filter((p) => p.type === "hello")).toHaveLength(0);
		expect(h.service.busy).toBe(false); // pending flag released for retry

		// data.cancelled counts as a refusal too.
		const h2 = harness();
		const t2 = await seedTarget(h2, [userEnd]);
		h2.bridge.scripted([
			resp("get_state", { isStreaming: false }),
			resp("switch_session", { cancelled: true }),
		]);
		await h2.service.switchTo(undefined, t2.id);
		expect(h2.errors[0]).toContain("切换会话失败");
	});
});

describe("SessionService.newSession", () => {
	it("waits for pi, resets synchronously, broadcasts hello sessionId=null", async () => {
		const h = harness();
		h.service.handleEvent(userEnd); // a live world exists
		expect(h.hub.history()).toHaveLength(1);

		h.bridge.scripted([
			resp("new_session", {}),
			resp("get_state", { sessionId: "fresh", sessionFile: join(h.store.dir, "pi-new.jsonl"), isStreaming: false }),
		]);
		await h.service.newSession(undefined);

		// Leading get_state = the birth probe from handleEvent above (it
		// auto-answers {} → no bind); then newSession's own sequence.
		expect(h.bridge.calls.map((c) => c.type)).toEqual(["get_state", "new_session", "get_state"]);
		expect(h.hub.history()).toEqual([]);
		expect(h.store.currentId).toBeNull();
		const hellos = h.broadcasts.filter((p) => p.type === "hello");
		expect(hellos).toHaveLength(1);
		expect(hellos[0].sessionId).toBeNull();
		expect(hellos[0].snapshot).toEqual([]);
		expect(h.folded.messages).toHaveLength(0);
		expect(h.service.currentPiFile).toBe(join(h.store.dir, "pi-new.jsonl"));
	});

	it("keeps the old world when pi refuses", async () => {
		const h = harness();
		h.service.handleEvent(userEnd);
		h.bridge.scripted([resp("new_session", undefined, false)]);
		await h.service.newSession(undefined);
		expect(h.errors[0]).toContain("new_session 失败");
		expect(h.hub.history()).toHaveLength(1); // nothing dropped
		// session_bound DID fire earlier (legit — the archive was created); the
		// point here is that no hello rebuilt any client.
		expect(h.broadcasts.filter((p) => p.type === "hello")).toHaveLength(0);
	});
});

describe("SessionService.handleEvent", () => {
	it("binds the pi file at lazy archive creation and whispers session_bound", async () => {
		const h = harness();
		const piFile = join(h.store.dir, "pi-live.jsonl");
		writeFileSync(piFile, "{}");
		h.bridge.scripted([resp("get_state", { sessionFile: piFile, isStreaming: false })]);
		await h.service.refreshPiSession();
		expect(h.service.currentPiFile).toBe(piFile);

		h.service.handleEvent(userEnd);
		const id = h.store.currentId!;
		expect(h.store.getEntry(id)?.piSessionPath).toBe(piFile);
		const bound = h.broadcasts.find((p) => p.type === "session_bound");
		expect(bound?.sessionId).toBe(id);
		expect(h.delivered).toEqual(["message_end"]);
	});

	it("birth probe re-binds a stale mapping (prompt raced new_session's get_state)", async () => {
		const h = harness();
		// Mapping in hand is the PREVIOUS pi file — new_session already
		// happened pi-side but our refresh hasn't landed yet (the original
		// bug: the new archive bound the old file, and every later resume
		// of it restored the WRONG context).
		h.bridge.scripted([resp("get_state", { sessionFile: "C:/old.jsonl", isStreaming: false })]);
		await h.service.refreshPiSession();
		expect(h.service.currentPiFile).toBe("C:/old.jsonl");

		h.bridge.scripted([resp("get_state", { sessionFile: "C:/new.jsonl", isStreaming: false })]);
		h.service.handleEvent(userEnd); // archive born → immediate bind (stale) + probe
		const id = h.store.currentId!;
		expect(h.store.getEntry(id)?.piSessionPath).toBe("C:/old.jsonl");
		await vi.waitFor(() => expect(h.store.getEntry(id)?.piSessionPath).toBe("C:/new.jsonl"));
		expect(h.service.currentPiFile).toBe("C:/new.jsonl");
	});

	it("whispers session_bound even without a pi file (no-session mode)", () => {
		const h = harness();
		h.service.handleEvent(userEnd);
		const id = h.store.currentId!;
		expect(h.store.getEntry(id)?.piSessionPath).toBeUndefined(); // no binding
		expect(h.broadcasts.find((p) => p.type === "session_bound")?.sessionId).toBe(id);
	});

	it("handleBridgeExit clears the stale pi mapping", async () => {
		const h = harness();
		const piFile = join(h.store.dir, "pi-dead.jsonl");
		writeFileSync(piFile, "{}");
		h.bridge.scripted([resp("get_state", { sessionFile: piFile })]);
		await h.service.refreshPiSession();
		h.service.handleBridgeExit();
		expect(h.service.currentPiFile).toBeNull();
	});
});

describe("SessionService.removeSession", () => {
	it("maps refusal reasons to HTTP statuses", async () => {
		const h = harness();
		h.store.append(userEnd);
		expect(h.service.removeSession("../evil").status).toBe(400);
		expect(h.service.removeSession(h.store.currentId!).status).toBe(409);
		expect(h.service.removeSession("2099-01-01T00-00-00-000Z").status).toBe(404);
	});

	it("deletes the pi file only under ~/.pi/agent/sessions (never the live one)", async () => {
		const h = harness();
		// Outside the pi sessions root: archive removed, file KEPT.
		h.store.append(userEnd);
		const id1 = h.store.currentId!;
		h.store.finalize(); // deleting the CURRENT session is the 409 above
		const outside = join(h.store.dir, "outside.jsonl");
		writeFileSync(outside, "{}");
		h.store.bindPiSession(id1, outside);
		expect(h.service.removeSession(id1).status).toBe(204);
		expect(existsSync(join(h.store.dir, `${id1}.jsonl`))).toBe(false);
		expect(existsSync(outside)).toBe(true);

		// Inside ~/.pi/agent/sessions: a temp file we own gets deleted.
		const piRoot = join(homedir(), ".pi", "agent", "sessions");
		mkdirSync(piRoot, { recursive: true });
		const inside = join(piRoot, `pi-graph-test-a-${Date.now()}.jsonl`);
		writeFileSync(inside, "{}");
		h.store.append(assistantEnd);
		const id2 = h.store.currentId!;
		h.store.finalize();
		h.store.bindPiSession(id2, inside);
		expect(h.service.removeSession(id2).status).toBe(204);
		expect(existsSync(inside)).toBe(false);

		// The file the LIVE bridge is writing is never deleted, even in-root.
		const live = join(piRoot, `pi-graph-test-b-${Date.now()}.jsonl`);
		writeFileSync(live, "{}");
		try {
			h.bridge.scripted([resp("get_state", { sessionFile: live, isStreaming: false })]);
			await h.service.refreshPiSession();
			h.store.append(userEnd);
			const id3 = h.store.currentId!;
			h.store.finalize(); // not current — the ONLY reason left is the liveness guard
			h.store.bindPiSession(id3, live);
			expect(h.service.removeSession(id3).status).toBe(204);
			expect(existsSync(live)).toBe(true);
		} finally {
			rmSync(live, { force: true });
		}
	});
});

/**
 * SessionService - the multi-session lifecycle core (new / switch / remove).
 *
 * Extracted from main.ts so the switch flow is unit-testable: main.ts owns
 * singletons and wiring, this class owns the ORDER of a session switch —
 * which is where every race lives:
 *
 *   guards (no pi round-trip) → get_state streaming double-check →
 *   buffer mode ON → RPC switch_session → rebind pi file mapping →
 *   rebuild fold state from the ARCHIVE (pi replays nothing on resume:
 *   session_start is not a wire event) → hub.load (no fan-out) →
 *   broadcast one `hello` (clients rebuild atomically) → buffer mode OFF.
 *
 * Events arriving while `switching` are buffered and appended to the resumed
 * session — they are either post-switch session events or straggler tails,
 * and both belong to the new world after the hello.
 */

import { existsSync, lstatSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	foldEvent,
	initState,
	type JsonAgentSessionEvent,
	type RpcCommand,
	type RpcGetStateData,
	type RpcResponse,
	type SessionState,
} from "@pi-graph/shared";
import type { EventHub } from "./event-hub.ts";
import type { SessionStore } from "./session-store.ts";

/** Mirror of the archive-id allowlist (SessionStore.read). */
const ID_RE = /^[0-9TZ-]+$/;

export interface BridgeLike {
	request(command: RpcCommand): Promise<RpcResponse>;
}

/** Minimal ws shape the service needs (the real one from `ws`). */
export interface WsLike {
	send(data: string): void;
}

export interface SessionServiceDeps {
	bridge: BridgeLike;
	hub: EventHub;
	store: SessionStore;
	/** Fold-based busy flag (session.agentStatus === "running"). */
	isAgentBusy(): boolean;
	/** Orchestration busy flag (RunManager.active — single-run contract). */
	isRunBusy(): boolean;
	/** Replace main.ts's module-level folded session state. */
	applySession(next: SessionState): void;
	/** Stringify once, send to every connected client. */
	broadcast(payload: unknown): void;
	/** Answer the requester with {type:"error", message}. undefined-safe. */
	replyError(ws: WsLike | undefined, message: string): void;
	/** runManager.retainedEvents() for the hello envelope. */
	retainedRunEvents(): unknown[];
	/** The normal live-event path: fold → hub.ingest → archive append. */
	deliverEvent(event: JsonAgentSessionEvent): void;
}

export class SessionService {
	private readonly deps: SessionServiceDeps;
	/** pi session file backing the CURRENT bridge session (get_state). */
	private currentPiSessionPath: string | null = null;
	/** Staleness guard for overlapping get_state probes (see refreshPiSession). */
	private piProbeToken = 0;
	private switching = false;
	private buffer: JsonAgentSessionEvent[] = [];

	constructor(deps: SessionServiceDeps) {
		this.deps = deps;
	}

	get busy(): boolean {
		return this.switching;
	}

	get currentPiFile(): string | null {
		return this.currentPiSessionPath;
	}

	/** Called for every pi stdout event (main.ts's sole bridge.on("event")). */
	handleEvent(event: JsonAgentSessionEvent): void {
		if (this.switching) {
			this.buffer.push(event);
			return;
		}
		const before = this.deps.store.currentId;
		this.deps.deliverEvent(event);
		const after = this.deps.store.currentId;
		// Archives are created lazily on the first event — the ONLY moment a
		// new archive id exists to bind the pi session file to.
		if (before === null && after !== null) {
			if (this.currentPiSessionPath) this.deps.store.bindPiSession(after, this.currentPiSessionPath);
			// The mapping just bound can be stale by one new_session: a prompt
			// that beats newSession's get_state would bind the PREVIOUS pi
			// file here, and every later resume of this archive would restore
			// the wrong context. A fresh get_state is authoritative — the turn
			// is running, so no switch can interleave (both guard on busy).
			void this.refreshPiSession(after);
			// Clients' last hello said sessionId:null (fresh session) and
			// nothing else would tell them until the next reconnect — whisper
			// the binding instead of re-broadcasting a full hello.
			this.deps.broadcast({ type: "session_bound", sessionId: after });
		}
	}

	/** Record which pi session file is live (get_state). Best-effort: a
	 *  failure costs resumability of the current session, nothing else.
	 *  `bornId` binds a freshly created archive explicitly (its birth and
	 *  the in-hand mapping can be milliseconds apart); responses are
	 *  token-guarded so an older overlapping probe can't regress the
	 *  mapping a newer one already wrote. */
	async refreshPiSession(bornId?: string): Promise<void> {
		const token = ++this.piProbeToken;
		try {
			const resp = await this.deps.bridge.request({ type: "get_state" });
			if (token !== this.piProbeToken) return;
			if (resp.success && resp.data) {
				const data = resp.data as RpcGetStateData;
				this.currentPiSessionPath = data.sessionFile ?? null;
				const id = bornId ?? this.deps.store.currentId;
				if (id && this.currentPiSessionPath) this.deps.store.bindPiSession(id, this.currentPiSessionPath);
			}
		} catch (err) {
			console.warn("[session] get_state failed:", err);
		}
	}

	/** pi subprocess died — its session mapping is stale. */
	handleBridgeExit(): void {
		this.currentPiSessionPath = null;
	}

	/** ＋新对话: reset pi + bridge state, tell clients with a fresh hello.
	 *  Mirrors the old inline flow: wait for pi's confirmation BEFORE
	 *  dropping state, then reset synchronously (no await between the
	 *  response and the reset — a following prompt must not race ahead). */
	async newSession(ws: WsLike | undefined): Promise<void> {
		if (this.switching) {
			this.deps.replyError(ws, "会话切换进行中，请稍候");
			return;
		}
		try {
			const resp = await this.deps.bridge.request({ type: "new_session" });
			if (!resp.success) {
				this.deps.replyError(ws, `new_session 失败: ${resp.error ?? "未知错误"}`);
				return;
			}
			this.deps.hub.clear();
			this.deps.applySession(initState());
			this.deps.store.finalize();
			// Refresh BEFORE the hello: a client may send a prompt the instant
			// it sees the fresh world, and that prompt's first event binds the
			// new archive to whatever mapping we hold — hold the hello until
			// the mapping is fresh (else the bind lands on the previous pi
			// file and later resumes restore the wrong context).
			await this.refreshPiSession();
			this.deps.broadcast({ type: "hello", snapshot: [], run: this.deps.retainedRunEvents(), sessionId: null });
			console.log("[session] new session started");
		} catch (err) {
			this.deps.replyError(ws, `new_session 失败: ${(err as Error).message}`);
		}
	}

	/** 恢复历史会话: RPC switch_session + archive-driven rebuild. */
	async switchTo(ws: WsLike | undefined, id: string): Promise<void> {
		const fail = (message: string) => this.deps.replyError(ws, message);
		if (typeof id !== "string" || !ID_RE.test(id)) return fail("会话 id 非法");
		if (this.switching) return fail("会话切换进行中，请稍候");
		if (id === this.deps.store.currentId) return fail("该会话已是当前会话");
		if (this.deps.isRunBusy()) return fail("编排运行中，不能切换会话（可先中止编排）");
		if (this.deps.isAgentBusy()) return fail("agent 运行中，不能切换会话（等待其停止或先中止）");

		const entry = this.deps.store.getEntry(id);
		if (!entry?.piSessionPath) return fail("该会话没有对应的 pi 会话文件，仅支持只读回放");
		// pi's SessionManager.open() silently CREATES an empty session when the
		// file is missing — without this check a resume would "succeed" with a
		// blank context (worst possible silent failure).
		if (!existsSync(entry.piSessionPath)) return fail("pi 会话文件已不存在，仅支持只读回放");
		const archiveEvents = await this.deps.store.read(id);
		if (archiveEvents.length === 0) return fail("找不到该会话的归档");

		// Busy double-check: the fold flag lags in the abort→settled gap.
		try {
			const state = await this.deps.bridge.request({ type: "get_state" });
			if (!state.success) return fail(`无法确认 agent 状态: ${state.error ?? "未知错误"}`);
			if ((state.data as RpcGetStateData | undefined)?.isStreaming) {
				return fail("agent 仍在输出，等待其完全停止后再切换");
			}
		} catch (err) {
			return fail(`无法确认 agent 状态: ${(err as Error).message}`);
		}

		this.switching = true;
		this.buffer = [];
		try {
			const resp = await this.deps.bridge.request({ type: "switch_session", sessionPath: entry.piSessionPath });
			if (!resp.success || (resp.data as { cancelled?: boolean } | undefined)?.cancelled) {
				this.replayBuffer();
				return fail(`切换会话失败: ${resp.error ?? "pi 拒绝了切换"}`);
			}
			// Bind the TARGET id, not currentId: store.resume(id) hasn't run
			// yet, so currentId still names the OUTGOING session — a bare
			// refresh here would re-bind the outgoing archive to the target's
			// pi file, and resuming it later would restore the wrong context.
			await this.refreshPiSession(id); // best-effort; pi has already switched

			// Rebuild the fold state from OUR archive (the view source) —
			// pi replays nothing on resume. Buffered events (arrived while
			// switching) belong to the resumed session: fold them too.
			const events = archiveEvents.concat(this.buffer);
			this.buffer = [];
			const rebuilt = initState();
			for (const event of events) foldEvent(rebuilt, event);
			// An archive can end mid-turn (server crash / pi exit) — a dangling
			// agentStatus "running" would wedge the UI in steer mode forever.
			rebuilt.agentStatus = "idle";
			rebuilt.streamingAssistant = null;
			rebuilt.streamingDraft = null;
			rebuilt.lastError = null;

			this.deps.hub.clear();
			this.deps.hub.load(events); // replay buffer only — hello drives the view
			this.deps.applySession(rebuilt);
			if (!this.deps.store.resume(id)) {
				console.error(`[session] resume(${id}) failed — archive vanished mid-switch?`);
			}
			this.deps.broadcast({ type: "hello", snapshot: events, run: this.deps.retainedRunEvents(), sessionId: id });
			console.log(`[session] switched to ${id} (${events.length} events, pi file: ${this.currentPiSessionPath ?? "?"})`);
		} catch (err) {
			this.replayBuffer();
			fail(`切换会话失败: ${(err as Error).message}`);
		} finally {
			this.switching = false;
			this.buffer = [];
		}
	}

	private replayBuffer(): void {
		const pending = this.buffer;
		this.buffer = [];
		for (const event of pending) this.deps.deliverEvent(event);
	}

	/** Delete an archive (+ index entry + pi session file). Returns the HTTP
	 *  status; the caller maps non-204 to a JSON error body. */
	removeSession(id: string): { status: 204 | 400 | 404 | 409; message?: string } {
		if (typeof id !== "string" || !ID_RE.test(id)) return { status: 400, message: "会话 id 非法" };
		if (id === this.deps.store.currentId) return { status: 409, message: "不能删除当前活跃会话（先切换到别的会话或新建）" };
		const entry = this.deps.store.getEntry(id);
		const archiveExists = existsSync(join(this.deps.store.dir, `${id}.jsonl`));
		if (!archiveExists && !entry) return { status: 404, message: "会话不存在" };

		const { removedArchive, piSessionPath } = this.deps.store.remove(id);
		let removedPiFile = false;
		if (piSessionPath && this.isSafePiPath(piSessionPath)) {
			try {
				rmSync(piSessionPath, { force: true }); // never recursive
				removedPiFile = true;
			} catch (err) {
				console.error(`[session] pi session file delete failed (${piSessionPath}):`, err);
			}
		} else if (piSessionPath) {
			console.warn(`[session] skipping unsafe pi session path: ${piSessionPath}`);
		}
		console.log(`[session] removed ${id} (archive=${removedArchive}, piFile=${removedPiFile})`);
		return { status: 204 };
	}

	/** A pi session path from the index is user-editable data — only delete
	 *  inside ~/.pi/agent/sessions, a real file (no symlinks), never the file
	 *  the live bridge is writing. */
	private isSafePiPath(p: string): boolean {
		try {
			const root = resolve(homedir(), ".pi", "agent", "sessions");
			const abs = resolve(p);
			const rel = relative(root, abs);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
			if (process.platform === "win32" && !abs.toLowerCase().startsWith(root.toLowerCase())) return false;
			if (abs === this.currentPiSessionPath) return false;
			return lstatSync(abs).isFile();
		} catch {
			return false;
		}
	}
}

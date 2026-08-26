/**
 * Global store: WebSocket connection to the bridge server + folded session
 * state + derived graph (recomputed on every event).
 *
 * Reconnects with exponential backoff; on reconnect the session state is
 * rebuilt from the bridge's hello snapshot (full replay buffer).
 */

import { create } from "zustand";
import {
	deriveGraph,
	foldEvent,
	initState,
	type Graph,
	type JsonAgentSessionEvent,
	type RunEvent,
	type SessionState,
} from "@pi-graph/shared";
// Circular import with orch-store.ts is INTENTIONAL and safe: both sides only
// hold function references that are called at runtime (never during module
// evaluation), and function declarations are hoisted before any import runs.
import { applyRunEvent, setOrchError, setRunSnapshot } from "./orch-store.ts";

export type WsStatus = "connecting" | "open" | "closed" | "reconnecting";

export const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) || "ws://localhost:8787";
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "http://localhost:8787";

interface SessionMeta {
	id: string;
	startedAt: number;
	endedAt: number;
	eventCount: number;
	firstUserText: string | null;
	outputTokens: number;
}

interface AppState {
	wsStatus: WsStatus;
	piExit: { code: number | null; stderr: string } | null;
	session: SessionState;
	graph: Graph;
	selectedNodeId: string | null;
	eventCount: number;
	lastEventAt: number | null;
	/** History browsing: when set, the canvas renders this instead of live. */
	history: { meta: SessionMeta; graph: Graph; loading: boolean } | null;
	historyOpen: boolean;
	sessions: SessionMeta[];
	/** Last sessions fetch failed (server down / blocked) — the drawer says so. */
	sessionsError: boolean;
	sendPrompt: (message: string) => void;
	steer: (message: string) => void;
	abort: () => void;
	newSession: () => void;
	select: (nodeId: string | null) => void;
	openHistory: () => Promise<void>;
	loadHistory: (id: string) => Promise<void>;
	exitHistory: () => void;
}

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
/** Monotonic token for in-flight history loads; bumped to cancel stale ones. */
let historyReq = 0;

function send(payload: unknown): void {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

/** Public send for sibling stores (orch) that share this socket. */
export function sendWs(payload: unknown): void {
	send(payload);
}

function ingest(store: AppState, events: JsonAgentSessionEvent[]): void {
	for (const event of events) foldEvent(store.session, event);
	// Recreate graph (pure) - React Flow consumers diff by id.
	(store as { graph: Graph }).graph = deriveGraph(store.session);
	// foldEvent mutates session in place; shallow-copy so zustand reference
	// selectors (Header/PromptBar read s.session) see a new object.
	(store as { session: SessionState }).session = { ...store.session };
}

function resetSession(): { session: SessionState; graph: Graph; piExit: null } {
	return { session: initState(), graph: { nodes: [], edges: [] }, piExit: null };
}

export const useStore = create<AppState>((set, get) => ({
	wsStatus: "connecting",
	piExit: null,
	session: initState(),
	graph: { nodes: [], edges: [] },
	selectedNodeId: null,
	eventCount: 0,
	lastEventAt: null,
	history: null,
	historyOpen: false,
	sessions: [],
	sessionsError: false,

	sendPrompt: (message) => send({ type: "command", command: { type: "prompt", message } }),
	steer: (message) => send({ type: "command", command: { type: "steer", message } }),
	abort: () => send({ type: "command", command: { type: "abort" } }),
	newSession: () => send({ type: "command", command: { type: "new_session" } }),
	select: (nodeId) => set({ selectedNodeId: nodeId }),
	openHistory: async () => {
		set({ historyOpen: true });
		try {
			const res = await fetch(`${API_BASE}/api/sessions`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const sessions: SessionMeta[] = await res.json();
			set({ sessions, sessionsError: false });
		} catch {
			// Server down or the response was blocked (e.g. CORS) — say so
			// instead of masquerading as 「暂无存档」.
			set({ sessions: [], sessionsError: true });
		}
	},
	loadHistory: async (id) => {
		const req = ++historyReq;
		set({
			history: {
				meta: { id, startedAt: 0, endedAt: 0, eventCount: 0, firstUserText: null, outputTokens: 0 },
				graph: { nodes: [], edges: [] },
				loading: true,
			},
		});
		try {
			const meta = get().sessions.find((s) => s.id === id);
			const res = await fetch(`${API_BASE}/api/sessions/${id}/events`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const events: JsonAgentSessionEvent[] = await res.json();
			const hist = initState();
			for (const e of events) foldEvent(hist, e);
			// Superseded (user hit 返回实时 or clicked another session) —
			// don't yank the UI back into history mode.
			if (req !== historyReq) return;
			set({
				history: {
					meta: meta ?? {
						id,
						startedAt: 0,
						endedAt: 0,
						eventCount: events.length,
						firstUserText: null,
						outputTokens: hist.usageTotal.output,
					},
					graph: deriveGraph(hist),
					loading: false,
				},
				selectedNodeId: null,
			});
		} catch {
			if (req === historyReq) set({ history: null, sessionsError: true });
		}
	},
	exitHistory: () => {
		historyReq++; // cancel any in-flight load
		set({ history: null, selectedNodeId: null });
	},
}));

/** Open the WebSocket (idempotent) and wire it into the store. */
export function connect(): void {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

	ws = new WebSocket(WS_URL);
	ws.onopen = () => {
		reconnectDelay = 1000;
		useStore.setState({ wsStatus: "open" });
	};
	ws.onclose = () => {
		ws = null;
		scheduleReconnect();
	};
	ws.onerror = () => {
		// onclose follows onerror; nothing extra to do here.
	};
	ws.onmessage = (msg) => {
		let envelope: {
			type: string;
			event?: JsonAgentSessionEvent;
			snapshot?: JsonAgentSessionEvent[];
			code?: number | null;
			stderr?: string;
			/** Orchestration: hello replays the retained run events (RunEvent[]). */
			run?: unknown;
			/** Orchestration: run_error payload. */
			message?: string;
			issues?: unknown;
		};
		try {
			envelope = JSON.parse(String(msg.data));
		} catch {
			return;
		}
		if (envelope.type === "reset") {
			// Bridge dropped the session - clear canvas, keep connection.
			useStore.setState((s) => ({ ...resetSession(), selectedNodeId: null }));
			return;
		}
		if (envelope.type === "hello" && envelope.snapshot) {
			// Fresh replay of the whole session - rebuild state from scratch.
			useStore.setState((s) => {
				const fresh = resetSession();
				ingest(fresh as AppState, envelope.snapshot!);
				return { ...fresh, eventCount: s.eventCount + envelope.snapshot!.length };
			});
			// Orchestration: also restore the retained run snapshot (absent
			// when the server has never run a graph).
			setRunSnapshot(envelope.run as RunEvent[] | undefined);
			return;
		}
		if (envelope.type === "event" && envelope.event) {
			useStore.setState((s) => {
				ingest(s as AppState, [envelope.event!]);
				return { eventCount: s.eventCount + 1, lastEventAt: Date.now() };
			});
			return;
		}
		if (envelope.type === "run_event" && envelope.event) {
			// Orchestration stream: the payload is a shared RunEvent (typed
			// loosely as JsonAgentSessionEvent in the envelope declaration).
			applyRunEvent(envelope.event as unknown as RunEvent);
			return;
		}
		if (envelope.type === "run_error") {
			setOrchError({ message: envelope.message, issues: envelope.issues });
			return;
		}
		if (envelope.type === "pi-exit") {
			useStore.setState({ piExit: { code: envelope.code ?? null, stderr: envelope.stderr ?? "" } });
		}
	};
}

function scheduleReconnect(): void {
	useStore.setState((s) => ({
		wsStatus: s.wsStatus === "open" ? "reconnecting" : s.wsStatus === "connecting" ? "closed" : "reconnecting",
	}));
	setTimeout(() => {
		if (!ws) connect();
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

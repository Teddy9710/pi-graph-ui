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
	type SessionState,
} from "@pi-graph/shared";

export type WsStatus = "connecting" | "open" | "closed" | "reconnecting";

export const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) || "ws://localhost:8787";

interface AppState {
	wsStatus: WsStatus;
	piExit: { code: number | null; stderr: string } | null;
	session: SessionState;
	graph: Graph;
	selectedNodeId: string | null;
	eventCount: number;
	lastEventAt: number | null;
	sendPrompt: (message: string) => void;
	steer: (message: string) => void;
	abort: () => void;
	select: (nodeId: string | null) => void;
}

let ws: WebSocket | null = null;
let reconnectDelay = 1000;

function send(payload: unknown): void {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
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

	sendPrompt: (message) => send({ type: "command", command: { type: "prompt", message } }),
	steer: (message) => send({ type: "command", command: { type: "steer", message } }),
	abort: () => send({ type: "command", command: { type: "abort" } }),
	select: (nodeId) => set({ selectedNodeId: nodeId }),
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
		};
		try {
			envelope = JSON.parse(String(msg.data));
		} catch {
			return;
		}
		if (envelope.type === "hello" && envelope.snapshot) {
			// Fresh replay of the whole session - rebuild state from scratch.
			useStore.setState((s) => {
				const fresh = resetSession();
				ingest(fresh as AppState, envelope.snapshot!);
				return { ...fresh, eventCount: s.eventCount + envelope.snapshot!.length };
			});
			return;
		}
		if (envelope.type === "event" && envelope.event) {
			useStore.setState((s) => {
				ingest(s as AppState, [envelope.event!]);
				return { eventCount: s.eventCount + 1, lastEventAt: Date.now() };
			});
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

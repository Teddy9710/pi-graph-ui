/**
 * pi-graph bridge server.
 *
 * Architecture:
 *   Browser --WebSocket--> this server --stdin/stdout JSONL--> pi --mode rpc
 *
 * WS protocol (server -> client, JSON):
 *   {type: "hello", snapshot: JsonAgentSessionEvent[]}  - on connect, full history
 *   {type: "event", event: JsonAgentSessionEvent}        - live events (throttled)
 *   {type: "response", response: RpcResponse}            - correlated RPC replies
 *   {type: "pi-exit", code, stderr}                      - subprocess died
 *
 * WS protocol (client -> server):
 *   {type: "command", command: RpcCommand}               - forwarded verbatim
 *   {type: "request", command: RpcCommand}               - forwarded, reply relayed
 *
 * HTTP:
 *   GET /health     - liveness + pi subprocess status
 *   GET /api/state  - folded session summary (from @pi-graph/shared)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { deriveGraph, foldEvent, initState, type SessionState } from "@pi-graph/shared";
import { EventHub } from "./event-hub.ts";
import { PiBridge } from "./pi-bridge.ts";

const PORT = Number(process.env.PORT ?? 8787);
const PI_BIN = process.env.PI_BIN;
const PI_CWD = process.env.PI_CWD ?? process.cwd();
/** Extra CLI args for pi, e.g. PI_ARGS="--model deepseek/deepseek-chat". */
const PI_ARGS = process.env.PI_ARGS?.split(/\s+/).filter(Boolean) ?? [];

// ============================================================================
// Bridge + hub wiring
// ============================================================================

const bridge = new PiBridge({ bin: PI_BIN, cwd: PI_CWD, extraArgs: PI_ARGS });
const hub = new EventHub({ intervalMs: 100 });
const session: SessionState = initState();

bridge.on("event", (event) => {
	foldEvent(session, event);
	hub.ingest(event);
});
bridge.on("exit", (code, stderr) => {
	console.error(`[pi] exited code=${code}\n${stderr}`);
	for (const client of wsClients()) {
		client.send(JSON.stringify({ type: "pi-exit", code, stderr }));
	}
});

// ============================================================================
// HTTP
// ============================================================================

const app = new Hono();
app.get("/health", (c) =>
	c.json({
		ok: true,
		pi: { running: bridge.running, cwd: PI_CWD },
		clients: wsClients().length,
	}),
);
app.get("/api/state", (c) => {
	const graph = deriveGraph(session);
	return c.json({
		agentStatus: session.agentStatus,
		usage: session.usageTotal,
		messageCount: session.messages.length,
		toolCount: session.tools.size,
		lastError: session.lastError,
		nodes: graph.nodes.length,
		edges: graph.edges.length,
	});
});

// ============================================================================
// WebSocket
// ============================================================================

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
	console.log(`pi-graph server listening on http://localhost:${info.port}`);
	console.log(`  pi cwd: ${PI_CWD}`);
	bridge.start();
	console.log(bridge.running ? "  pi rpc subprocess started" : "  pi rpc subprocess FAILED to start");
});

// serve()'s declared return union includes http2 variants; with these options
// it always creates a plain http.Server at runtime.
const wss = new WebSocketServer({ server: server as unknown as import("node:http").Server });

interface ClientInfo {
	id: string;
	request?: { resolve: (r: unknown) => void; reject: (e: Error) => void };
}
const clients = new Map<WebSocket, ClientInfo>();
let nextClientId = 1;

function wsClients(): WebSocket[] {
	return [...clients.keys()];
}

wss.on("connection", (ws) => {
	const info: ClientInfo = { id: `c${nextClientId++}` };
	clients.set(ws, info);

	// Replay full history so the new client reconstructs the same session.
	ws.send(JSON.stringify({ type: "hello", snapshot: hub.history() }));
	console.log(`[ws] ${info.id} connected (${clients.size} total)`);

	const unsubscribe = hub.subscribe((event) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "event", event }));
	});

	ws.on("message", (data) => {
		let msg: { type: string; command?: unknown };
		try {
			msg = JSON.parse(String(data));
		} catch {
			return;
		}
		if (msg.type === "command" || msg.type === "request") {
			try {
				bridge.send(msg.command as never);
				if (msg.type === "command") {
					ws.send(JSON.stringify({ type: "ack", commandType: (msg.command as { type: string }).type }));
				}
			} catch (err) {
				ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
			}
			return;
		}
		if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
	});

	ws.on("close", () => {
		unsubscribe();
		clients.delete(ws);
		console.log(`[ws] ${info.id} disconnected (${clients.size} total)`);
	});
});

// Correlated RPC responses: broadcast so the requesting client (any) gets them.
bridge.on("response", (response) => {
	for (const ws of wsClients()) {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", response }));
	}
});

// ============================================================================
// Shutdown
// ============================================================================

function shutdown(): void {
	console.log("\nshutting down...");
	bridge.kill();
	for (const ws of wsClients()) ws.close();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

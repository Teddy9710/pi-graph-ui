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

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { deriveGraph, foldEvent, initState, type SessionState } from "@pi-graph/shared";
import { EventHub } from "./event-hub.ts";
import { PiBridge } from "./pi-bridge.ts";
import { SessionStore } from "./session-store.ts";
import { Leaderboard } from "./snake/leaderboard.ts";
import { snakeRoutes } from "./snake/routes.ts";

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
const store = new SessionStore();
let session: SessionState = initState();

/** Reset bridge-side state (new_session) and tell every client to rebuild. */
function resetSession(): void {
	hub.clear();
	session = initState();
	store.finalize();
	for (const client of wsClients()) {
		client.send(JSON.stringify({ type: "reset" }));
	}
	console.log("[session] reset");
}

bridge.on("event", (event) => {
	foldEvent(session, event);
	hub.ingest(event);
	store.append(event);
});
bridge.on("exit", (code, stderr) => {
	console.error(`[pi] exited code=${code}\n${stderr}`);
	store.finalize();
	for (const client of wsClients()) {
		client.send(JSON.stringify({ type: "pi-exit", code, stderr }));
	}
});

// ============================================================================
// HTTP
// ============================================================================

const app = new Hono();

// ----------------------------------------------------------------------------
// Security middleware: minimal hardening shared by all routes.
// ----------------------------------------------------------------------------
app.use("*", async (c, next) => {
	// Clickjacking + MIME sniffing hardening.
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "no-referrer");
	// Basic CSP for the snake demo page (served from this origin).
	if (c.req.path === "/snake" || c.req.path === "/") {
		c.header(
			"Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
		);
	}
	await next();
});

// Snake game sub-API (leaderboard + token issuance).
app.route("/api/snake", snakeRoutes({ leaderboard: new Leaderboard() }));

app.get("/snake", (c) => c.html(snakeHtml()));
app.get("/", (c) => c.html(snakeHtml()));

app.get("/health", (c) =>
	c.json({
		ok: true,
		pi: { running: bridge.running, cwd: PI_CWD },
		clients: wsClients().length,
	}),
);
app.get("/api/sessions", async (c) => c.json(await store.list()));
app.get("/api/sessions/:id/events", async (c) => c.json(await store.read(c.req.param("id"))));
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

// Serve the snake HTML inline (keep single-file front-end).
let SNAKE_HTML = "";
function snakeHtml(): string {
	if (!SNAKE_HTML) {
		try {
			SNAKE_HTML = readFileSync(new URL("../../snake.html", import.meta.url), "utf8");
		} catch {
			SNAKE_HTML = "<h1>snake.html not found</h1>";
		}
	}
	return SNAKE_HTML;
}

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
				const command = msg.command as { type?: string } | undefined;
				// Session reset: wait for pi's confirmation before dropping state —
				// an immediately-following prompt raced ahead of the reset gets
				// swallowed by pi otherwise (prompt response arrives before the
				// new_session response).
				if (command?.type === "new_session") {
					bridge
						.request({ type: "new_session" })
						.then((response) => {
							if (response.success) resetSession();
							else ws.send(JSON.stringify({ type: "error", message: "new_session failed" }));
						})
						.catch((err: Error) => ws.send(JSON.stringify({ type: "error", message: err.message })));
					return;
				}
				bridge.send(msg.command as never);
				if (msg.type === "command") {
					ws.send(JSON.stringify({ type: "ack", commandType: command?.type }));
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

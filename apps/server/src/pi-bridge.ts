/**
 * PiBridge - manage a `pi --mode rpc` child process.
 *
 * Wire contract (pi 0.84.x):
 * - stdin:  JSONL RpcCommand lines (prompt / steer / abort / get_state / ...)
 * - stdout: JSONL lines - either a JsonAgentSessionEvent (bare object, no
 *   envelope) or an RpcResponse {id, type:"response", command, success, data}
 *   correlated by id.
 * - stderr: diagnostics (model errors, extension load failures).
 *
 * Distinguishing the two stdout shapes: RpcResponse is the only line type with
 * `type === "response"`.
 */

import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { JsonAgentSessionEvent, RpcCommand, RpcResponse } from "@pi-graph/shared";

export interface PiBridgeOptions {
	/** pi executable. Default: "pi" (pi.cmd on Windows). */
	bin?: string;
	/** Working directory for the agent. Default: process.cwd(). */
	cwd?: string;
	/** Extra CLI args inserted before --mode rpc. */
	extraArgs?: string[];
	/** Pass --no-session so the bridge owns session lifetime. Default: true. */
	noSession?: boolean;
}

interface ClassifiedLine {
	kind: "event" | "response";
	event?: JsonAgentSessionEvent;
	response?: RpcResponse;
}

export function classifyLine(line: string): ClassifiedLine | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return null; // non-JSON diagnostic line; ignore (stderr carries the rest)
	}
	if (obj && typeof obj === "object" && (obj as { type?: string }).type === "response") {
		return { kind: "response", response: obj as RpcResponse };
	}
	return { kind: "event", event: obj as JsonAgentSessionEvent };
}

export class PiBridge extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
	private stdoutBuffer = "";
	private stderrTail = "";
	private exited = false;

	readonly options: PiBridgeOptions;

	constructor(options: PiBridgeOptions = {}) {
		super();
		this.options = options;
	}

	get running(): boolean {
		return this.proc !== null && !this.exited;
	}

	/** Spawn the pi rpc subprocess. No-op if already running. */
	start(): void {
		if (this.running) return;
		this.exited = false;
		const bin = this.options.bin ?? (process.platform === "win32" ? "pi.cmd" : "pi");
		const args: string[] = [];
		if (this.options.extraArgs?.length) args.push(...this.options.extraArgs);
		args.push("--mode", "rpc");
		if (this.options.noSession !== false) args.push("--no-session");

		this.proc = spawn(bin, args, {
			cwd: this.options.cwd ?? process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			// Windows: pi installs as a .cmd shim; Node refuses to spawn .cmd
			// without a shell. Args are fixed constants here (user text reaches
			// pi via stdin), so shell quoting is not a concern.
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(bin),
		}) as ChildProcessWithoutNullStreams;

		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4096);
			this.emit("stderr", chunk);
		});
		this.proc.on("error", (err) => {
			this.emit("exit", null, `spawn failed: ${err.message}`);
			this.cleanup();
		});
		this.proc.on("close", (code) => {
			this.rejectAllPending(`pi exited with code ${code}`);
			this.emit("exit", code, this.stderrTail);
			this.cleanup();
		});
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		const lines = this.stdoutBuffer.split("\n");
		this.stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const classified = classifyLine(line);
			if (!classified) continue;
			if (classified.kind === "event") {
				this.emit("event", classified.event);
			} else {
				const response = classified.response!;
				const id = response.id;
				if (id !== undefined) {
					const waiter = this.pending.get(id);
					if (waiter) {
						this.pending.delete(id);
						waiter.resolve(response);
					}
				}
				this.emit("response", response);
			}
		}
	}

	private cleanup(): void {
		this.exited = true;
		this.proc = null;
	}

	private rejectAllPending(reason: string): void {
		for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
		this.pending.clear();
	}

	/** Send a raw RPC command (fire and forget). */
	send(command: RpcCommand): void {
		if (!this.proc || this.exited) throw new Error("pi bridge is not running");
		this.proc.stdin.write(JSON.stringify(command) + "\n");
	}

	/** Send an RPC command and await its correlated response. */
	request(command: Omit<RpcCommand, "id"> & { id?: string }): Promise<RpcResponse> {
		if (!this.proc || this.exited) return Promise.reject(new Error("pi bridge is not running"));
		const id = String(this.nextId++);
		const full = { ...command, id } as RpcCommand;
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.proc!.stdin.write(JSON.stringify(full) + "\n");
			} catch (err) {
				this.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	/** Terminate the subprocess. */
	kill(): void {
		if (this.proc && !this.exited) {
			try {
				this.proc.stdin.end();
			} catch {
				/* already closed */
			}
			this.proc.kill();
		}
	}
}

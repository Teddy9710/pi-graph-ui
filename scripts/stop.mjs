#!/usr/bin/env node
/**
 * Stop a dev stack that outlived its terminal (eval F10): hard-killing
 * dev.mjs (task manager, crashed terminal window) used to leave the bridge
 * server and vite orphaned, still holding ports 8787/5173 until reboot.
 *
 * Strategy:
 *   1. pidfile (<tmpdir>/pi-graph-dev-pids.json, written by dev.mjs) — kill
 *      each recorded tree, server first so the pi rpc bridges under it die
 *      with it, then vite, then the dev parent.
 *   2. Port-scan fallback: whoever still LISTENs on 8787/5173 goes down even
 *      when the pidfile is missing or stale (a reboot recycles pids).
 *
 * Usage: node scripts/stop.mjs   (or: pnpm stop)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIDFILE = join(tmpdir(), "pi-graph-dev-pids.json");
/** This project's dev ports: server :8787, vite :5173 plus its auto-bump
 *  range (when 5173+ are taken by an older instance, vite walks upward). */
const PORTS = [8787, 5173, 5174, 5175, 5176, 5177, 5178, 5179];

/** Is this pid a node.exe? (Refuses to taskkill a non-node port squatter.) */
function isNode(pid) {
	if (process.platform !== "win32") return true; // no cheap check — trust the caller
	try {
		const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
		return out.replace(/"/g, "").split(",")[0] === "node.exe";
	} catch {
		return false;
	}
}

/** Full-tree kill of one pid; false when it was already dead. */
function treeKill(pid, label) {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
			console.log(`  killed ${label} (pid ${pid})`);
			return true;
		} catch {
			return false; // already gone
		}
	}
	try {
		process.kill(pid, "SIGTERM");
		console.log(`  killed ${label} (pid ${pid})`);
		return true;
	} catch {
		return false;
	}
}

/** PIDs LISTENING on a port (Windows netstat; empty elsewhere/on failure). */
function pidsOnPort(port) {
	if (process.platform !== "win32") return [];
	try {
		const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
		const pids = new Set();
		for (const line of out.split(/\r?\n/)) {
			// Local-address column ends with :port (IPv4 and [::] alike); only
			// LISTENING lines count, so a client's ephemeral port never matches.
			if (!new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, "i").test(line)) continue;
			const pid = Number(line.trim().split(/\s+/).pop());
			if (Number.isInteger(pid) && pid > 0) pids.add(pid);
		}
		return [...pids];
	} catch {
		return [];
	}
}

let killed = 0;

// --- 1) pidfile: ordered tree kills ---------------------------------------
if (existsSync(PIDFILE)) {
	try {
		const { dev, children = [] } = JSON.parse(readFileSync(PIDFILE, "utf8"));
		const ordered = [
			...children.filter((c) => c.name === "server"), // pi bridges die with it
			...children.filter((c) => c.name !== "server"),
			{ name: "dev", pid: dev },
		];
		for (const { name, pid } of ordered) {
			if (treeKill(pid, name)) killed++;
		}
	} catch (err) {
		console.warn(`pidfile 不可读（${err.message}）— 回退到端口扫描`);
	}
	rmSync(PIDFILE, { force: true });
} else {
	console.log("no pidfile — relying on the port scan");
}

// Give the tree kills a moment to release their sockets before scanning.
await new Promise((r) => setTimeout(r, 1000));

// --- 2) port-scan fallback -------------------------------------------------
for (const port of PORTS) {
	for (const pid of pidsOnPort(port)) {
		if (!isNode(pid)) {
			console.log(`  skipping :${port} (pid ${pid} is not node.exe)`);
			continue;
		}
		if (treeKill(pid, `listener on :${port}`)) killed++;
	}
}

console.log(killed === 0 ? "没有需要清理的进程（端口 8787/5173 空闲）" : `已清理 ${killed} 个进程树`);

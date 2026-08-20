#!/usr/bin/env node
/**
 * Environment self-check for pi-graph.
 * Verifies: pi CLI on PATH, rpc mode responds, subagent extension loaded,
 * model configured. Run: node scripts/check-env.mjs
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const results = [];

function report(name, ok, detail) {
	results.push({ name, ok, detail });
	const icon = ok ? "✓" : "✗";
	console.log(`${icon} ${name}${detail ? ` - ${detail}` : ""}`);
}

function piBin() {
	return process.platform === "win32" ? "pi.cmd" : "pi";
}

function runPi(args, input, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const proc = spawn(piBin(), args, {
			stdio: ["pipe", "pipe", "pipe"],
			shell: process.platform === "win32", // .cmd shim needs a shell
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
		proc.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: -1, out, err: String(e) });
		});
		if (input) {
			proc.stdin.write(input);
			proc.stdin.end();
		}
	});
}

// 1. pi --version
const version = await runPi(["--version"], null, 10000);
report("pi CLI", version.code === 0, version.out.trim() || version.err.trim());

// 2. rpc mode get_state
const rpc = await runPi(["--mode", "rpc", "--no-session"], '{"id":"1","type":"get_state"}\n');
let state = null;
for (const line of rpc.out.split("\n")) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === "response" && obj.command === "get_state") {
			state = obj;
			break;
		}
	} catch {
		/* skip */
	}
}
report("pi --mode rpc", !!state, state?.success ? "responds to get_state" : rpc.err.slice(0, 200));
if (state?.success) {
	report(
		"model configured",
		!!state.data?.model?.id,
		`${state.data?.model?.id ?? "none"} (${state.data?.model?.provider ?? "?"})`,
	);
}

// 3. subagent extension presence (runtime tool listing needs a model call, so
// check the files + that pi can list extensions from stderr on startup).
const extDir = join(homedir(), ".pi", "agent", "extensions", "subagent");
report(
	"subagent extension installed",
	existsSync(join(extDir, "index.ts")),
	existsSync(extDir) ? extDir : "missing - copy examples/extensions/subagent from the pi package",
);

const agentsDir = join(extDir, "agents");
if (existsSync(agentsDir)) {
	const { readdirSync } = await import("node:fs");
	const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
	report("agent definitions", agents.length > 0, agents.join(", "));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\nall checks passed" : `\n${failed.length} check(s) failed`);
process.exit(failed.length === 0 ? 0 : 1);

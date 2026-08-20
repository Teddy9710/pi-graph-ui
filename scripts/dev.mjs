#!/usr/bin/env node
/**
 * One-command dev startup: bridge server (:8787) + web dev server (:5173).
 *
 * Usage:
 *   node scripts/dev.mjs
 *
 * Configuration (env vars, or a .env file in the repo root):
 *   DEEPSEEK_API_KEY   DeepSeek API key (required for the default model)
 *   PI_ARGS            extra pi CLI args (default: --model deepseek/deepseek-chat)
 *   PI_BIN             pi executable override (default: pi / pi.cmd)
 *   PI_CWD             working directory for the agent (default: apps/server)
 *   PORT               bridge server port (default: 8787)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (KEY=VALUE lines, no quotes needed).
const envFile = join(root, ".env");
if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
	}
}

if (!process.env.DEEPSEEK_API_KEY) {
	console.warn("⚠ DEEPSEEK_API_KEY 未设置 — pi 将无法调用模型。");
	console.warn("  可在仓库根目录创建 .env 文件写入 DEEPSEEK_API_KEY=sk-...（已被 gitignore）");
}

// Default model: the DeepSeek provider declared in ~/.pi/agent/models.json.
// Override with PI_ARGS in .env or the shell.
process.env.PI_ARGS ??= "--model deepseek/deepseek-chat";

const children = [];

function run(name, cwd, command, args) {
	// shell:true on Windows splits unquoted paths with spaces (C:\Program Files),
	// so quote the executable when a shell is used.
	const useShell = process.platform === "win32";
	const proc = useShell
		? spawn(`"${command}" ${args.join(" ")}`, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: true,
				env: process.env,
			})
		: spawn(command, args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
	proc.stdout.on("data", (d) =>
		process.stdout.write(String(d).split("\n").filter(Boolean).map((l) => `[${name}] ${l}\n`).join("")),
	);
	proc.stderr.on("data", (d) =>
		process.stderr.write(String(d).split("\n").filter(Boolean).map((l) => `[${name}] ${l}\n`).join("")),
	);
	proc.on("close", (code) => {
		console.log(`[${name}] exited (${code})`);
		if (shuttingDown) return;
		shutdown(code === 0 ? 0 : 1);
	});
	children.push(proc);
	return proc;
}

let shuttingDown = false;
function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const c of children) {
		try {
			c.kill();
		} catch {
			/* already gone */
		}
	}
	setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("pi-graph dev 启动中… Ctrl+C 退出全部\n");
run("server", join(root, "apps/server"), process.execPath, [
	"src/main.ts",
]);
run("web", join(root, "apps/web"), process.execPath, ["node_modules/vite/bin/vite.js"]);

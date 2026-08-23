/**
 * RunStore - orchestration run archive.
 *
 * One JSONL file per run under ~/.pi-graph-ui/runs/ (the event model differs
 * from session traces, so runs deliberately do NOT go into SessionStore).
 * Writes are best-effort: a failed write disables archival for the run but
 * never disturbs the live orchestrator (append runs synchronously inside the
 * engine's event emit path).
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@pi-graph/shared";

export interface RunMeta {
	id: string;
	startedAt: number;
	endedAt: number;
	status: string;
	ok: number;
	failed: number;
	skipped: number;
}

export class RunStore {
	readonly dir: string;
	private disabled = false;

	constructor(dir: string = join(homedir(), ".pi-graph-ui", "runs")) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	private fileFor(id: string): string {
		return join(this.dir, `${id}.jsonl`);
	}

	/** Best-effort append of one run event. */
	append(event: RunEvent): void {
		// A new run retries archival — write failures are often transient
		// (AV lock, dir recreated); without this, one error silences the
		// archive for the whole process lifetime. plan_started counts too:
		// a plan that fails before any node ran is still a run.
		if (event.type === "run_started" || event.type === "plan_started") this.disabled = false;
		if (this.disabled) return;
		try {
			appendFileSync(this.fileFor(event.runId), JSON.stringify(event) + "\n");
		} catch (err) {
			console.error("[run-store] archival failed, disabling for this run:", err);
			this.disabled = true;
		}
	}

	/** Stream one archive back as an event array. */
	async read(id: string): Promise<RunEvent[]> {
		const file = this.fileFor(id);
		// Strict id allowlist keeps read() inside dir. runIds look like
		// orch-mx1y2z3-1 ([a-z0-9-], no path separators).
		if (!/^[A-Za-z0-9-]+$/.test(id) || !existsSync(file)) return [];
		const events: RunEvent[] = [];
		const rl = createInterface({ input: createReadStream(file, "utf8") });
		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as RunEvent);
			} catch {
				/* tolerate torn tail lines */
			}
		}
		return events;
	}

	/** List archived runs (newest first) with folded summaries. */
	async list(): Promise<RunMeta[]> {
		const metas: RunMeta[] = [];
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const id = name.slice(0, -".jsonl".length);
			if (!/^[A-Za-z0-9-]+$/.test(id)) continue;
			const events = await this.read(id);
			// A run begins with run_started (manual) or plan_started (auto) —
			// a plan that failed before any node ran is still a listed run.
			const started = events.find(
				(e): e is Extract<RunEvent, { type: "run_started" }> | Extract<RunEvent, { type: "plan_started" }> =>
					e.type === "run_started" || e.type === "plan_started",
			);
			if (!started) continue; // empty header-only file
			let finished: Extract<RunEvent, { type: "run_finished" }> | null = null;
			for (let i = events.length - 1; i >= 0; i--) {
				if (events[i]!.type === "run_finished") {
					finished = events[i] as Extract<RunEvent, { type: "run_finished" }>;
					break;
				}
			}
			metas.push({
				id,
				startedAt: started.startedAt,
				endedAt: finished ? finished.finishedAt : started.startedAt,
				status: finished ? finished.status : "incomplete",
				ok: finished?.ok ?? 0,
				failed: finished?.failed ?? 0,
				skipped: finished?.skipped ?? 0,
			});
		}
		return metas.sort((a, b) => b.endedAt - a.endedAt);
	}
}

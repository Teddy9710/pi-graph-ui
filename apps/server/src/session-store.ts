/**
 * SessionStore - bridge-side session archive.
 *
 * pi runs with --no-session (no disk persistence of its own), so the bridge
 * archives the raw event stream itself: one JSONL file per session under
 * ~/.pi-graph-ui/sessions/. A session's archive starts lazily on its first
 * event and finalizes on new_session / pi exit.
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonAgentSessionEvent } from "@pi-graph/shared";

export interface SessionMeta {
	id: string;
	/** File mtime-based bounds (epoch ms). */
	startedAt: number;
	endedAt: number;
	eventCount: number;
	/** First user prompt text (preview for the list UI). */
	firstUserText: string | null;
	/** Total assistant output tokens folded from the archive. */
	outputTokens: number;
}

function firstUserText(events: JsonAgentSessionEvent[]): string | null {
	for (const e of events) {
		if (e.type === "message_end" && e.message.role === "user") {
			const c = e.message.content;
			const text =
				typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join(" ");
			const oneLine = text.replace(/\s+/g, " ").trim();
			return oneLine.slice(0, 120) || null;
		}
	}
	return null;
}

export class SessionStore {
	readonly dir: string;
	private currentId: string | null = null;
	/** Set when an archival write fails; drops history, never the live bridge. */
	private disabled = false;

	constructor(dir: string = join(homedir(), ".pi-graph-ui", "sessions")) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	private fileFor(id: string): string {
		return join(this.dir, `${id}.jsonl`);
	}

	/** Append an event to the current session archive (lazily created). */
	append(event: JsonAgentSessionEvent): void {
		if (this.disabled) return;
		try {
			if (this.currentId === null) {
				this.currentId = new Date().toISOString().replace(/[:.]/g, "-");
			}
			appendFileSync(this.fileFor(this.currentId), JSON.stringify(event) + "\n");
		} catch (err) {
			// Archival is best-effort: a failed write (dir removed, disk full,
			// AV lock) must not crash the live bridge — this handler runs
			// synchronously inside the pi stdout event emitter.
			console.error("[session-store] archival failed, disabling for this session:", err);
			this.disabled = true;
		}
	}

	/** Finalize the current archive (next event starts a fresh session). */
	finalize(): void {
		this.currentId = null;
		// Write failures are often transient locks — retry next session.
		this.disabled = false;
	}

	/** Stream one archive back as an event array. */
	async read(id: string): Promise<JsonAgentSessionEvent[]> {
		const file = this.fileFor(id);
		// Strict id allowlist (no '.', '/', '\', ':') keeps read() inside dir.
		// append() ids look like 2026-08-21T01-38-58-392Z — the trailing 'Z'
		// MUST be allowed or every archive reads back empty.
		if (!/^[0-9TZ-]+$/.test(id) || !existsSync(file)) return [];
		const events: JsonAgentSessionEvent[] = [];
		const rl = createInterface({ input: createReadStream(file, "utf8") });
		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				/* tolerate torn tail lines */
			}
		}
		return events;
	}

	/** List archived sessions (newest first) with folded summaries. */
	async list(): Promise<SessionMeta[]> {
		const metas: SessionMeta[] = [];
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const id = name.slice(0, -".jsonl".length);
			const file = this.fileFor(id);
			const stat = statSync(file);
			const events = await this.read(id);
			let output = 0;
			for (const e of events) {
				if (e.type === "message_end" && e.message.role === "assistant") output += e.message.usage.output || 0;
			}
			metas.push({
				id,
				startedAt: stat.birthtimeMs,
				endedAt: stat.mtimeMs,
				eventCount: events.length,
				firstUserText: firstUserText(events),
				outputTokens: output,
			});
		}
		return metas.sort((a, b) => b.endedAt - a.endedAt);
	}
}

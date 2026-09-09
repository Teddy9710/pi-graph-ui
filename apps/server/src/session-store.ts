/**
 * SessionStore - bridge-side session archive.
 *
 * The bridge archives the raw event stream itself: one JSONL file per session
 * under ~/.pi-graph-ui/sessions/. A session's archive starts lazily on its
 * first event and finalizes on new_session / pi exit / switch.
 *
 * index.json (same dir) carries the sideband metadata the events cannot:
 * the mapping archive id → pi's own session file (what makes the archive
 * RESUMABLE via RPC switch_session) and the user-chosen title. Writes are
 * best-effort like everything here — a failed index save never drops the
 * live event stream.
 */

import {
	appendFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	/** User-chosen title (index.json); UI falls back to firstUserText. */
	title?: string;
	/** pi's own session file, when this archive was bound to one. */
	piSessionPath?: string;
	/** A pi session file exists on disk → the conversation can be resumed. */
	resumable: boolean;
}

/** Sideband metadata per archive id (index.json). */
interface IndexEntry {
	piSessionPath?: string;
	title?: string;
	createdAt: number;
}

interface IndexFile {
	version: 1;
	entries: Record<string, IndexEntry>;
}

/** Mirror of the archive-id allowlist used by read(). */
const ID_RE = /^[0-9TZ-]+$/;
/** Titles share the 120-char budget of the auto-derived firstUserText. */
export const MAX_TITLE_CHARS = 120;

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

/** Title validation shared by store.rename and the HTTP layer. */
export function isValidTitle(title: string): boolean {
	if (title !== title.trim()) return false;
	if (!title || title.length > MAX_TITLE_CHARS) return false;
	// No newlines / control chars — titles render on one line and travel
	// through JSON files that humans edit.
	return !/[\u0000-\u001f\u007f]/.test(title);
}

export class SessionStore {
	readonly dir: string;
	private current: string | null = null;
	/** Set when an archival write fails; drops history, never the live bridge. */
	private disabled = false;
	private index: IndexFile;

	constructor(dir: string = join(homedir(), ".pi-graph-ui", "sessions")) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
		this.index = this.loadIndex();
	}

	private get indexFile(): string {
		return join(this.dir, "index.json");
	}

	private loadIndex(): IndexFile {
		try {
			const raw = readFileSync(this.indexFile, "utf8");
			const parsed = JSON.parse(raw) as IndexFile;
			if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
				return { version: 1, entries: parsed.entries };
			}
			throw new Error("unexpected index shape");
		} catch (err) {
			if (existsSync(this.indexFile)) {
				// Keep the broken file for inspection, start clean — archives
				// still list fine, they just degrade to non-resumable/untitled.
				try {
					renameSync(this.indexFile, `${this.indexFile}.corrupt`);
				} catch {
					/* read-only dir etc. — nothing more to do */
				}
				console.error("[session-store] index.json unreadable, quarantined and rebuilt:", err);
			}
			return { version: 1, entries: {} };
		}
	}

	/** Atomic-ish index save (tmp + rename); best-effort like archival. */
	private saveIndex(): void {
		try {
			const tmp = `${this.indexFile}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.index));
			renameSync(tmp, this.indexFile);
		} catch (err) {
			console.error("[session-store] index save failed (continuing):", err);
		}
	}

	/** Archive id events currently append to (hello.sessionId, delete guard). */
	get currentId(): string | null {
		return this.current;
	}

	/** Index entry for an archive id (typed copy), if any. */
	getEntry(id: string): IndexEntry | null {
		const e = this.index.entries[id];
		return e ? { ...e } : null;
	}

	private fileFor(id: string): string {
		return join(this.dir, `${id}.jsonl`);
	}

	/** Append an event to the current session archive (lazily created). */
	append(event: JsonAgentSessionEvent): void {
		if (this.disabled) return;
		try {
			if (this.current === null) {
				// Ids are millisecond timestamps; a finalize + append inside the
				// same ms would collide into one file — de-collide explicitly.
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				let id = stamp;
				let n = 2;
				while (existsSync(this.fileFor(id))) id = `${stamp}-${n++}`;
				this.current = id;
			}
			appendFileSync(this.fileFor(this.current), JSON.stringify(event) + "\n");
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
		this.current = null;
		// Write failures are often transient locks — retry next session.
		this.disabled = false;
	}

	/** Continue writing an EXISTING archive id (switch_session resume path).
	 *  The id must pass the same allowlist as read() and exist on disk. */
	resume(id: string): boolean {
		if (!ID_RE.test(id) || !existsSync(this.fileFor(id))) return false;
		this.current = id;
		this.disabled = false;
		return true;
	}

	/** Record which pi session file backs an archive (makes it resumable). */
	bindPiSession(id: string, piSessionPath: string | null | undefined): void {
		if (!ID_RE.test(id)) return;
		const entry = (this.index.entries[id] ??= { createdAt: Date.now() });
		if (piSessionPath) entry.piSessionPath = piSessionPath;
		this.saveIndex();
	}

	/** Set a user-chosen title. Returns false (unchanged) on invalid input. */
	rename(id: string, title: string): boolean {
		if (!ID_RE.test(id) || !isValidTitle(title)) return false;
		const entry = (this.index.entries[id] ??= { createdAt: Date.now() });
		entry.title = title;
		this.saveIndex();
		return true;
	}

	/** Delete an archive + its index entry; returns the pi file path so the
	 *  caller (SessionService) can apply its path-safety rules to the delete. */
	remove(id: string): { removedArchive: boolean; piSessionPath?: string } {
		const entry = this.index.entries[id];
		const file = this.fileFor(id);
		const removedArchive = ID_RE.test(id) && existsSync(file);
		if (removedArchive) {
			try {
				rmSync(file, { force: true });
			} catch (err) {
				console.error("[session-store] archive delete failed:", err);
				return { removedArchive: false, piSessionPath: entry?.piSessionPath };
			}
		}
		if (entry) {
			delete this.index.entries[id];
			this.saveIndex();
		}
		return { removedArchive, piSessionPath: entry?.piSessionPath };
	}

	/** Stream one archive back as an event array. */
	async read(id: string): Promise<JsonAgentSessionEvent[]> {
		const file = this.fileFor(id);
		// Strict id allowlist (no '.', '/', '\', ':') keeps read() inside dir.
		// append() ids look like 2026-08-21T01-38-58-392Z — the trailing 'Z'
		// MUST be allowed or every archive reads back empty.
		if (!ID_RE.test(id) || !existsSync(file)) return [];
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
			const entry = this.index.entries[id];
			const piSessionPath = entry?.piSessionPath;
			metas.push({
				id,
				startedAt: stat.birthtimeMs,
				endedAt: stat.mtimeMs,
				eventCount: events.length,
				firstUserText: firstUserText(events),
				outputTokens: output,
				...(entry?.title !== undefined ? { title: entry.title } : {}),
				...(piSessionPath !== undefined ? { piSessionPath } : {}),
				// pi only flushes its session file on the first assistant
				// message — an unflushed mapping must not offer "resume".
				resumable: !!piSessionPath && existsSync(piSessionPath),
			});
		}
		// Newest first; equal mtimes (same-ms writes) tie-break on the
		// timestamp id, which sorts lexicographically chronologically.
		return metas.sort((a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id));
	}
}

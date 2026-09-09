import { mkdtempSync, appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, isValidTitle } from "../src/session-store.ts";
import type { JsonAgentSessionEvent } from "@pi-graph/shared";

/** Cast helper: tests only exercise the fields the store reads. */
const ev = (e: unknown) => e as JsonAgentSessionEvent;

const userEnd = ev({
	type: "message_end",
	message: { role: "user", content: [{ type: "text", text: "  用 bash   执行 echo  " }] },
});
const assistantEnd = ev({
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		usage: { input: 10, output: 42, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
	},
});

const dirs: string[] = [];
function freshStore(): SessionStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-graph-sessions-"));
	dirs.push(dir);
	return new SessionStore(dir);
}
afterEach(() => {
	while (dirs.length) {
		try {
			rmSync(dirs.pop()!, { recursive: true, force: true });
		} catch {
			/* Windows may lag on handle release */
		}
	}
});

describe("SessionStore", () => {
	it("round-trips append -> list -> read (ids with trailing Z validate)", async () => {
		const store = freshStore();
		store.append(ev({ type: "agent_start" }));
		store.append(userEnd);
		store.append(assistantEnd);

		const metas = await store.list();
		expect(metas).toHaveLength(1);
		expect(metas[0].eventCount).toBe(3);
		expect(metas[0].firstUserText).toBe("用 bash 执行 echo");
		expect(metas[0].outputTokens).toBe(42);

		// The critical regression guard: read() must accept the generated id
		// (append() ids end in 'Z', e.g. 2026-08-21T01-38-58-392Z).
		const events = await store.read(metas[0].id);
		expect(events.map((e) => e.type)).toEqual(["agent_start", "message_end", "message_end"]);
	});

	it("finalize starts a new archive on the next event", async () => {
		const store = freshStore();
		store.append(userEnd);
		store.finalize();
		store.append(assistantEnd);
		const metas = await store.list();
		expect(metas).toHaveLength(2);
		expect(metas[0].eventCount).toBe(1); // newest first
		expect(metas[0].firstUserText).toBeNull();
	});

	it("rejects ids that could escape the sessions dir", async () => {
		const store = freshStore();
		store.append(userEnd);
		expect(await store.read("../evil")).toEqual([]);
		expect(await store.read("a/b")).toEqual([]);
		expect(await store.read("..\\evil")).toEqual([]);
		expect(await store.read("no-such-session")).toEqual([]);
	});

	it("tolerates a torn trailing line when reading", async () => {
		const store = freshStore();
		store.append(userEnd);
		store.append(assistantEnd);
		const { id } = (await store.list())[0];
		appendFileSync(join(store.dir, `${id}.jsonl`), '{"type":"message_end","message":{"rol'); // torn tail
		const events = await store.read(id);
		expect(events).toHaveLength(2);
	});

	it("append never throws when the archive dir disappears mid-session", () => {
		const store = freshStore();
		store.append(userEnd);
		rmSync(store.dir, { recursive: true, force: true });
		expect(() => store.append(assistantEnd)).not.toThrow();
	});

	it("exposes currentId transitions and validates resume()", async () => {
		const store = freshStore();
		expect(store.currentId).toBeNull(); // lazy: no archive until the first event
		store.append(userEnd);
		const { id } = (await store.list())[0];
		expect(store.currentId).toBe(id);
		store.finalize();
		expect(store.currentId).toBeNull();
		// resume continues writing an EXISTING archive; unknown/illegal ids fail.
		expect(store.resume(id)).toBe(true);
		store.append(assistantEnd);
		const metas = await store.list();
		expect(metas).toHaveLength(1);
		expect(metas[0].eventCount).toBe(2); // same archive, not a new one
		expect(store.resume("no-such-session")).toBe(false);
		expect(store.resume("../evil")).toBe(false);
	});

	it("bindPiSession records the mapping; resumable follows the file on disk", async () => {
		const store = freshStore();
		store.append(userEnd);
		const { id } = (await store.list())[0];
		const piFile = join(store.dir, "pi-session.jsonl"); // any path we control
		writeFileSync(piFile, "{}");

		expect(store.getEntry(id)?.piSessionPath).toBeUndefined();
		store.bindPiSession(id, piFile);
		expect(store.getEntry(id)?.piSessionPath).toBe(piFile);

		// pi only flushes its session file on the first assistant message —
		// resumable must track existsSync, not just the mapping.
		expect((await store.list()).find((m) => m.id === id)?.resumable).toBe(true);
		rmSync(piFile);
		expect((await store.list()).find((m) => m.id === id)?.resumable).toBe(false);
	});

	it("rename persists titles through list() and validates input", async () => {
		const store = freshStore();
		store.append(userEnd);
		const { id } = (await store.list())[0];

		expect(store.rename(id, "  小明的会话  ")).toBe(false); // must be pre-trimmed
		expect(store.rename(id, "")).toBe(false);
		expect(store.rename(id, "a".repeat(121))).toBe(false);
		expect(store.rename(id, "bad\nline")).toBe(false);
		expect(store.rename("../evil", "x")).toBe(false); // id allowlist still applies
		expect(store.rename(id, "小明的会话")).toBe(true);
		expect((await store.list())[0].title).toBe("小明的会话");
		// rename also creates an entry for a known-good id that has no mapping yet
		expect(store.rename(id, "again")).toBe(true);
		expect(store.getEntry(id)?.title).toBe("again");
	});

	it("remove deletes the archive and returns the pi file path for the caller", async () => {
		const store = freshStore();
		store.append(userEnd);
		const { id } = (await store.list())[0];
		store.bindPiSession(id, join(store.dir, "pi.jsonl"));

		const result = store.remove(id);
		expect(result.removedArchive).toBe(true);
		expect(result.piSessionPath).toBe(join(store.dir, "pi.jsonl"));
		expect(existsSync(join(store.dir, `${id}.jsonl`))).toBe(false);
		expect(store.getEntry(id)).toBeNull(); // index entry gone too
		expect(await store.read(id)).toEqual([]);
		// removing again: nothing on disk, no entry — reports not-removed
		expect(store.remove(id).removedArchive).toBe(false);
	});

	it("quarantines a corrupt index.json and degrades gracefully", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-graph-sessions-"));
		dirs.push(dir);
		writeFileSync(join(dir, "index.json"), "{ not json");
		const store = new SessionStore(dir);
		// The broken file moved aside, a clean index took over.
		expect(existsSync(join(dir, "index.json.corrupt"))).toBe(true);
		expect(store.getEntry("anything")).toBeNull();

		store.append(userEnd);
		const { id } = (await store.list())[0];
		expect(store.rename(id, "still works")).toBe(true);
		const reopened = new SessionStore(dir); // index round-trips through disk
		expect(reopened.getEntry(id)?.title).toBe("still works");
	});
});

describe("isValidTitle", () => {
	it("accepts trimmed 1–120 char strings without control characters", () => {
		expect(isValidTitle("a")).toBe(true);
		expect(isValidTitle("你好世界")).toBe(true);
		expect(isValidTitle("a".repeat(120))).toBe(true);
		expect(isValidTitle("tabs\tinside")).toBe(false);
		expect(isValidTitle(" lead")).toBe(false);
		expect(isValidTitle("trail ")).toBe(false);
		expect(isValidTitle("")).toBe(false);
		expect(isValidTitle("a".repeat(121))).toBe(false);
	});
});

import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.ts";
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
});

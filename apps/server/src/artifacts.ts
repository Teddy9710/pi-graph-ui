/**
 * 节点产物目录（artifacts）— per-run/per-node output management.
 *
 * Layout: `<root>/<runId>/<nodeId>/` where root is ORCH_ARTIFACTS_DIR
 * (default ~/.pi-graph-ui/artifacts, sibling of the runs/ archive). The dir
 * is the default subprocess cwd for nodes without an explicit workdir, and
 * holds the archived `output.md` (final output text + a small header) for
 * every completed/reused node. All writes are best-effort: a failure
 * degrades that node (or, on IO errors, that run) back to pre-feature
 * behavior — it must never fail the run itself.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRunId } from "./infra/id-regex.ts";

/**
 * Windows reserved device names pass NODE_ID_RE ([A-Za-z0-9_-]{1,64}) but
 * cannot be directory names there (mkdir fails / paths resolve to devices).
 */
const WINDOWS_RESERVED_DIR_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Per-node artifacts dir `<root>/<runId>/<nodeId>`.
 * Returns null when runId/nodeId cannot be a directory name — the caller
 * silently degrades that node to pre-feature behavior (cwd = server base,
 * no output.md) instead of failing the run.
 */
export function nodeArtifactsDir(root: string, runId: string, nodeId: string): string | null {
	// runIds are `orch-<base36>-<seq>` by construction; isRunId is defense in
	// depth against archived/foreign events. Node ids pass NODE_ID_RE at
	// validation; the reserved-name check is the Windows gap that regex misses.
	if (!isRunId(runId)) return null;
	if (nodeId.length === 0 || nodeId.length > 64 || WINDOWS_RESERVED_DIR_RE.test(nodeId)) return null;
	return join(root, runId, nodeId);
}

/** Optional header lines for output.md (only present fields are written). */
export interface NodeOutputMeta {
	label?: string;
	model?: string;
	endedAt?: number;
	durationMs?: number;
	attempts?: number;
	fromRunId?: string;
}

/** Pure output.md body: UTF-8/LF text with a `key: value` header block. */
export function formatNodeOutput(runId: string, nodeId: string, text: string, meta: NodeOutputMeta): string {
	const lines = [`runId: ${runId}`, `nodeId: ${nodeId}`];
	if (meta.label !== undefined) lines.push(`label: ${meta.label}`);
	if (meta.model !== undefined) lines.push(`model: ${meta.model}`);
	if (meta.endedAt !== undefined) lines.push(`endedAt: ${new Date(meta.endedAt).toISOString()}`);
	if (meta.durationMs !== undefined) lines.push(`durationMs: ${meta.durationMs}`);
	if (meta.attempts !== undefined) lines.push(`attempts: ${meta.attempts}`);
	if (meta.fromRunId !== undefined) lines.push(`fromRunId: ${meta.fromRunId}`);
	// The body is stored verbatim (archived output is uncapped, same as the
	// RunStore JSONL event text).
	return `${lines.join("\n")}\n\n---\n\n${text}\n`;
}

/**
 * Best-effort `output.md` write into an already-validated dir (the caller
 * computed it via nodeArtifactsDir). Returns false on IO failure — the
 * run-manager latches per run; never throws.
 */
export function writeNodeOutput(dir: string, text: string, runId: string, nodeId: string, meta: NodeOutputMeta): boolean {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "output.md"), formatNodeOutput(runId, nodeId, text, meta), "utf8");
		return true;
	} catch (err) {
		console.error(`[artifacts] output.md 写入失败 (${dir}):`, err);
		return false;
	}
}

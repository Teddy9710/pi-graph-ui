/**
 * Atomic file writes — write to a sibling .tmp then rename.
 *
 * A direct `writeFileSync` on the target file can be observed mid-write by
 * readers (and on Windows, in-place overwrites can fail with EBUSY when an
 * AV scanner or backup tool has a brief handle). The tmp+rename pattern
 * keeps the live file either fully old or fully new at every observation
 * point. The single rename is atomic on POSIX and atomic-enough on NTFS.
 */

import { renameSync, writeFileSync } from "node:fs";

/** Write `content` to `path` atomically (tmp + rename). */
export function atomicWriteFile(path: string, content: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

/** JSON-encode `obj` and write it to `path` atomically. */
export function atomicWriteJson(path: string, obj: unknown): void {
	atomicWriteFile(path, `${JSON.stringify(obj)}\n`);
}

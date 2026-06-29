// Per-session memo for the CLI token-usage readers.
//
// CLI agents (Claude/Codex) carry no token telemetry, so Kanban re-reads their
// on-disk session transcript at every turn boundary (and on relaunch). Those
// files grow monotonically with conversation length, so naively re-reading and
// re-parsing the *whole* file on every turn is ≈ O(turns × final-size) — roughly
// quadratic in transcript bytes over a long session (finding T2).
//
// This memo lets a refresh skip the re-read+re-parse when the file is byte-for-byte
// unchanged since the previous read: usage only changes when the transcript grows,
// and a grown file has a different `(mtime, size)`. For Codex the memo's `filePath`
// also pins the resolved rollout so the next refresh skips the directory walk that
// located it (finding T1) — the path is stable within a launch, and the session
// manager drops the memo on relaunch so a resumed conversation re-resolves.
//
// The memo is owned per-session by the session manager (no module-level mutable
// state) and threaded through the read functions, which keeps them pure-by-input
// and unit-testable.

import { stat } from "node:fs/promises";

import type { RuntimeTaskSessionUsage } from "../core/api-contract";

/** Identity of an on-disk transcript file at the time it was last read+parsed. */
export interface UsageFileSignature {
	/** File mtime in epoch ms. */
	mtimeMs: number;
	/** File size in bytes. */
	size: number;
}

/**
 * Memo of the last token-usage read for one session's transcript file. Held by the
 * session manager on the {@link SessionEntry} and reset to `null` on relaunch.
 */
export interface SessionUsageReadCache extends UsageFileSignature {
	/** Absolute path of the transcript file this memo describes. */
	filePath: string;
	/** Usage parsed from that exact `(filePath, mtime, size)`; `null` when it carried none. */
	usage: RuntimeTaskSessionUsage | null;
}

/**
 * Stat a transcript file for its cache signature, or `null` when it can't be
 * statted (missing/unreadable). Never throws — the usage read path degrades
 * silently to "no usage".
 */
export async function statUsageFile(filePath: string): Promise<UsageFileSignature | null> {
	try {
		const stats = await stat(filePath);
		return { mtimeMs: stats.mtimeMs, size: stats.size };
	} catch {
		return null;
	}
}

/**
 * True when a memo still describes the given file path + freshly-statted signature
 * — i.e. the file has not changed since the cached read, so the cached usage may be
 * reused without re-reading or re-parsing.
 */
export function isUsageCacheFresh(
	cache: SessionUsageReadCache | null | undefined,
	filePath: string,
	signature: UsageFileSignature,
): cache is SessionUsageReadCache {
	return (
		cache != null &&
		cache.filePath === filePath &&
		cache.mtimeMs === signature.mtimeMs &&
		cache.size === signature.size
	);
}

// Token-usage reader for Codex (OpenAI's CLI) terminal sessions.
//
// Like Claude, Codex emits no structured token telemetry to Kanban but records
// it to a local session transcript: the rollout JSONL it writes under
// `<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`. Among its
// records are `event_msg`/`token_count` events carrying a *cumulative*
// `total_token_usage` block for the whole session. The newest matching rollout's
// last such event therefore holds the session's running total — there is no
// summing across events (that would multiply-count).
//
//口径 matches pi/Claude (real usage, no estimation):
//   inputTokens  = total_token_usage.input_tokens   (already includes cached input)
//   outputTokens = total_token_usage.output_tokens  (already includes reasoning output)
//   totalTokens  = inputTokens + outputTokens
// Unlike Claude — which reports cache tokens *separately* and must fold them into
// input — Codex's `input_tokens` already counts `cached_input_tokens`, and
// `output_tokens` already counts `reasoning_output_tokens`, so they map straight
// through with no addition (folding them again would double-count).
//
// The rollout file is located by reusing `codex-session-capture`'s cwd-matching
// scan (each task runs in its own worktree, so cwd disambiguates sessions that
// share a `~/.codex` default login). Fault tolerance is mandatory — this runs on
// the session hot path and must never throw: a missing dir/file, a torn trailing
// line, and missing/garbage fields all degrade to a safe value (null or 0).

import { readFile } from "node:fs/promises";

import type { RuntimeTaskSessionUsage } from "../core/api-contract";
import { parseJsonl } from "../fs/jsonl";
import { findLatestCodexRollout } from "./codex-session-capture";
import { isUsageCacheFresh, type SessionUsageReadCache, statUsageFile } from "./session-usage-cache";

/** Coerce an unknown JSON value to a non-negative finite number, else 0. */
function toNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Parse a Codex rollout transcript (JSONL) into cumulative token usage, or `null`
 * when no `token_count` event carries a `total_token_usage` block. Pure and total:
 * never throws.
 *
 * `total_token_usage` is cumulative across the whole session, so the *last* valid
 * event wins (it holds the running total). Summing every event would
 * multiply-count.
 */
export function parseCodexRolloutUsage(content: string): RuntimeTaskSessionUsage | null {
	let inputTokens = 0;
	let outputTokens = 0;
	let sawAnyUsage = false;

	for (const parsed of parseJsonl(content)) {
		if (!parsed || typeof parsed !== "object") {
			continue;
		}
		const record = parsed as { type?: unknown; payload?: unknown };
		if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") {
			continue;
		}
		const payload = record.payload as { type?: unknown; info?: unknown };
		if (payload.type !== "token_count" || !payload.info || typeof payload.info !== "object") {
			continue;
		}
		const info = payload.info as { total_token_usage?: unknown };
		if (!info.total_token_usage || typeof info.total_token_usage !== "object") {
			continue;
		}
		const totals = info.total_token_usage as { input_tokens?: unknown; output_tokens?: unknown };

		// Cumulative — last valid event wins.
		inputTokens = toNonNegativeNumber(totals.input_tokens);
		outputTokens = toNonNegativeNumber(totals.output_tokens);
		sawAnyUsage = true;
	}

	if (!sawAnyUsage) {
		return null;
	}
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export interface CodexSessionUsageInput {
	/** The Codex sessions directory to scan (the effective CODEX_HOME's `sessions`). */
	sessionsDir: string;
	/** The task worktree cwd that identifies this session's rollout. */
	cwd: string;
}

/** Result of a cached rollout read: the usage plus the memo to feed back next time. */
export interface CodexSessionUsageResult {
	usage: RuntimeTaskSessionUsage | null;
	cache: SessionUsageReadCache | null;
}

/**
 * Read and accumulate cumulative token usage from the Codex rollout matching this
 * task's worktree cwd. Returns `{ usage: null }` (never throws) when no rollout
 * matches, the file is unreadable, or it carries no usage — every failure degrades
 * silently.
 *
 * Two caching layers (findings T1 + T2), both keyed off the threaded `cache`:
 *  - **Resolved-path reuse:** when the memo's rollout file still exists, its path is
 *    reused directly, skipping the `~/.codex/sessions` tree walk that located it.
 *    The path is stable within a launch; the session manager drops the memo on
 *    relaunch, so a resumed conversation re-resolves via the locator.
 *  - **Read skip:** when that file is also unchanged `(mtime, size)`, the prior
 *    parse is reused without re-reading or re-parsing the (growing) rollout.
 */
export async function readCodexSessionUsage(
	input: CodexSessionUsageInput,
	cache?: SessionUsageReadCache | null,
): Promise<CodexSessionUsageResult> {
	if (!input.sessionsDir || !input.cwd) {
		return { usage: null, cache: null };
	}

	// Reuse the previously-resolved rollout path when it still exists — this skips
	// the directory walk entirely on every turn after the first (finding T1). The
	// existence stat doubles as the change-detection signature.
	let filePath: string | null = null;
	let signature = cache?.filePath ? await statUsageFile(cache.filePath) : null;
	if (signature && cache?.filePath) {
		filePath = cache.filePath;
	} else {
		// No usable memo: locate the rollout. No mtime floor — at a turn boundary the
		// current session's rollout is the newest one matching this cwd.
		const located = await findLatestCodexRollout({
			sessionsDir: input.sessionsDir,
			cwd: input.cwd,
			sinceMs: Number.NEGATIVE_INFINITY,
		});
		if (!located) {
			return { usage: null, cache: null };
		}
		filePath = located.file;
		signature = await statUsageFile(filePath);
		if (!signature) {
			return { usage: null, cache: null };
		}
	}

	if (isUsageCacheFresh(cache, filePath, signature)) {
		return { usage: cache.usage, cache };
	}
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		return { usage: null, cache: null };
	}
	const usage = parseCodexRolloutUsage(content);
	return { usage, cache: { filePath, mtimeMs: signature.mtimeMs, size: signature.size, usage } };
}

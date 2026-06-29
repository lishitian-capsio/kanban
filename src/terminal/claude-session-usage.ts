// Token-usage reader for Claude Code (and Claude-compatible) terminal sessions.
//
// Unlike pi, CLI agents emit no structured token telemetry to Kanban. Claude
// instead records every message — including its per-message `usage` — to a local
// session transcript at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, one
// JSON object per line. Kanban already pins `--session-id` at launch (see the
// Claude adapter), so the file path is derivable from the task's cwd + the
// recorded `agentSessionId`. This module parses that file and folds the per-turn
// usage into the cumulative `RuntimeTaskSessionUsage` the session card renders.
//
// Cumulative accounting matches pi's real-API口径 (no estimation):
//   inputTokens  = Σ (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
//   outputTokens = Σ output_tokens
//   totalTokens  = inputTokens + outputTokens
// Cache-creation and cache-read tokens are folded into inputTokens deliberately:
// they are real billed input the model processed, just served from / written to
// the prompt cache. The chip therefore reflects everything the request consumed.
//
// Fault tolerance is mandatory — this runs on the session hot path and must never
// throw: a missing file, an unset session id, a torn trailing line from a crash
// mid-write, and missing/garbage fields all degrade to a safe value (null or 0).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeTaskSessionUsage } from "../core/api-contract";
import { isUsageCacheFresh, type SessionUsageReadCache, statUsageFile } from "./session-usage-cache";

/**
 * Encode a cwd into Claude's on-disk project directory name. Claude replaces
 * every `/` and `.` in the absolute path with `-` (e.g.
 * `/home/dev/proj/.x` → `-home-dev-proj--x`).
 */
export function encodeClaudeProjectSlug(cwd: string): string {
	return cwd.replace(/[/.]/g, "-");
}

export interface ClaudeSessionFileInput {
	/** The task worktree cwd Claude was launched in. */
	cwd: string;
	/** The pinned Claude session id (Kanban's `--session-id`/`--resume` UUID). */
	sessionId: string;
	/** Override Claude's config dir (defaults to `~/.claude`); for tests. */
	claudeConfigDir?: string;
}

/** Resolve `<claudeConfigDir>/projects/<cwd-slug>/<sessionId>.jsonl`. */
export function resolveClaudeSessionFilePath(input: ClaudeSessionFileInput): string {
	const base = input.claudeConfigDir?.trim() || join(homedir(), ".claude");
	return join(base, "projects", encodeClaudeProjectSlug(input.cwd), `${input.sessionId}.jsonl`);
}

/** Coerce an unknown JSON value to a non-negative finite number, else 0. */
function toNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Parse a Claude session transcript (JSONL) into cumulative token usage, or
 * `null` when no usage is present. Pure and total: never throws.
 *
 * A single assistant turn writes one JSONL line per content block, and every one
 * of those lines repeats the same `message.id` and the *same* cumulative `usage`
 * for that message. Summing every line would multiply-count, so usage is keyed by
 * `message.id` and counted once per message (last write wins — the values are
 * identical anyway). Lines with no `message.id` (older formats / edge cases) are
 * each counted as a distinct contribution since they can't be deduplicated.
 */
export function parseClaudeSessionUsage(content: string): RuntimeTaskSessionUsage | null {
	const inputByMessageId = new Map<string, number>();
	const outputByMessageId = new Map<string, number>();
	let anonymousInput = 0;
	let anonymousOutput = 0;
	let sawAnyUsage = false;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Torn/garbage line (e.g. a crash mid-write) — skip it.
			continue;
		}
		if (!parsed || typeof parsed !== "object") {
			continue;
		}
		const record = parsed as { type?: unknown; message?: unknown };
		if (record.type !== "assistant" || !record.message || typeof record.message !== "object") {
			continue;
		}
		const message = record.message as { id?: unknown; usage?: unknown };
		if (!message.usage || typeof message.usage !== "object") {
			continue;
		}
		const usage = message.usage as {
			input_tokens?: unknown;
			cache_creation_input_tokens?: unknown;
			cache_read_input_tokens?: unknown;
			output_tokens?: unknown;
		};
		const input =
			toNonNegativeNumber(usage.input_tokens) +
			toNonNegativeNumber(usage.cache_creation_input_tokens) +
			toNonNegativeNumber(usage.cache_read_input_tokens);
		const output = toNonNegativeNumber(usage.output_tokens);

		sawAnyUsage = true;
		const messageId = typeof message.id === "string" && message.id ? message.id : null;
		if (messageId) {
			inputByMessageId.set(messageId, input);
			outputByMessageId.set(messageId, output);
		} else {
			anonymousInput += input;
			anonymousOutput += output;
		}
	}

	if (!sawAnyUsage) {
		return null;
	}

	let inputTokens = anonymousInput;
	let outputTokens = anonymousOutput;
	for (const value of inputByMessageId.values()) {
		inputTokens += value;
	}
	for (const value of outputByMessageId.values()) {
		outputTokens += value;
	}
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** Result of a cached transcript read: the usage plus the memo to feed back next time. */
export interface ClaudeSessionUsageResult {
	usage: RuntimeTaskSessionUsage | null;
	cache: SessionUsageReadCache | null;
}

/**
 * Read and accumulate cumulative token usage from a Claude session transcript.
 * Returns `{ usage: null }` (never throws) when the session id is unset, the file
 * is absent, or it carries no usage — every failure degrades silently.
 *
 * When `cache` describes the same file at the same `(mtime, size)`, the prior
 * parse is reused and the file is neither re-read nor re-parsed (finding T2). The
 * returned `cache` should be threaded back into the next call.
 */
export async function readClaudeSessionUsage(
	input: ClaudeSessionFileInput,
	cache?: SessionUsageReadCache | null,
): Promise<ClaudeSessionUsageResult> {
	const sessionId = input.sessionId?.trim();
	if (!sessionId) {
		// No session id yet — keep any prior memo; the file path is unknowable.
		return { usage: cache?.usage ?? null, cache: cache ?? null };
	}
	const filePath = resolveClaudeSessionFilePath({ ...input, sessionId });
	const signature = await statUsageFile(filePath);
	if (!signature) {
		return { usage: null, cache: null };
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
	const usage = parseClaudeSessionUsage(content);
	return { usage, cache: { filePath, mtimeMs: signature.mtimeMs, size: signature.size, usage } };
}

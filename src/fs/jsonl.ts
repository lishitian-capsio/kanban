// Bun-preferred JSONL (newline-delimited JSON) parsing with a Node fallback.
//
// The runtime is Bun-only, so in production this takes the Bun path:
// `Bun.JSONL.parseChunk` is a SIMD-accelerated, zero-copy parser over the raw
// bytes — the main win over `split("\n")` + per-line `JSON.parse`. The one
// environment without a `Bun` global is CI running the suite under Node
// `vitest` (`environment: "node"`), where it transparently falls back to the
// hand-written split parser (byte-for-byte the previous behavior).
//
// Fault-tolerance contract (identical on both engines, matching the callers this
// replaces — journal transcript reads, Claude/Codex token-usage parsing):
//   - blank / whitespace-only lines are skipped
//   - a torn trailing line (crash mid-write, no closing newline) is dropped
//   - a *complete* but malformed line in the middle is skipped and parsing
//     continues past it — this is the subtle part: `Bun.JSONL.parse` STOPS at
//     the first malformed line and discards everything after it, which would
//     silently truncate a transcript. `parseChunk` instead reports the error +
//     the byte offset it stopped at, so we skip the one bad line and resume,
//     replicating the `try { JSON.parse } catch { continue }` loop exactly.
// `parseJsonl` never throws; a caller applies its own per-record validation
// (zod, field coercion) to the returned values.

const NEWLINE = 0x0a;

type JsonlEngine = "bun" | "fallback";

let forcedEngine: JsonlEngine | null = null;

/**
 * Test-only override so a single test process can pin an engine. `null` restores
 * auto-detect. Mirrors `__setFastFileEngineForTest` in `fast-file.ts`.
 */
export function __setJsonlEngineForTest(engine: JsonlEngine | null): void {
	forcedEngine = engine;
}

interface BunJsonlChunkResult {
	values: unknown[];
	read: number;
	done: boolean;
	error: unknown;
}

interface BunJsonl {
	parseChunk(bytes: Uint8Array): BunJsonlChunkResult;
}

function bunJsonl(): BunJsonl | null {
	const bun = (globalThis as { Bun?: { JSONL?: unknown } }).Bun;
	const jsonl = bun?.JSONL as Partial<BunJsonl> | undefined;
	return typeof jsonl?.parseChunk === "function" ? (jsonl as BunJsonl) : null;
}

/** Which engine is currently active (respects the test override). */
export function activeJsonlEngine(): JsonlEngine {
	if (forcedEngine !== null) {
		return forcedEngine;
	}
	return bunJsonl() ? "bun" : "fallback";
}

/** Pure-JS reference parser: `split("\n")` + per-line `JSON.parse`, skip-on-error. */
function parseJsonlFallback(content: string): unknown[] {
	const values: unknown[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		try {
			values.push(JSON.parse(line));
		} catch {
			// Torn/garbage line (e.g. a crash mid-write) — skip it and continue.
		}
	}
	return values;
}

/** Bun-native parser: loop `parseChunk`, skipping one line past each parse error. */
function parseJsonlBun(engine: BunJsonl, content: string): unknown[] {
	const bytes = new TextEncoder().encode(content);
	const values: unknown[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const result = engine.parseChunk(bytes.subarray(offset));
		for (const value of result.values) {
			values.push(value);
		}
		if (!result.error) {
			// Either the whole remaining buffer parsed cleanly (`done`) or the only
			// leftover is an incomplete/torn trailing line — nothing more to recover.
			break;
		}
		// A *complete* line failed to parse. `read` stops at/just-before the newline
		// terminating the last good line, so the malformed line begins after it. Skip
		// to the newline that terminates the malformed line and resume from there.
		const malformedStart = offset + result.read;
		let nextNewline = bytes.indexOf(NEWLINE, malformedStart);
		if (nextNewline === malformedStart) {
			// `read` landed on the good line's own terminator; the malformed line's
			// terminator is the next one.
			nextNewline = bytes.indexOf(NEWLINE, malformedStart + 1);
		}
		if (nextNewline === -1) {
			// The malformed line has no closing newline — treat as a torn tail.
			break;
		}
		offset = nextNewline + 1;
	}
	return values;
}

/**
 * Parse newline-delimited JSON into an array of values, skipping blank, torn, and
 * malformed lines (never throws). Uses `Bun.JSONL` when available, else a pure-JS
 * fallback; both are behavior-equivalent.
 */
export function parseJsonl(content: string): unknown[] {
	if (activeJsonlEngine() === "bun") {
		const engine = bunJsonl();
		if (engine) {
			return parseJsonlBun(engine, content);
		}
	}
	return parseJsonlFallback(content);
}

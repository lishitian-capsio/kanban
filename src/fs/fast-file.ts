// Bun-preferred file read/write primitives with a Node `fs` fallback.
//
// The runtime is Bun-only, so in production these always take the Bun path:
// `Bun.file().json()` parses natively (the main win over `readFile` + `JSON.parse`)
// and `Bun.write` writes without the extra `fs` bookkeeping. The one environment
// without a `Bun` global is CI running the suite under Node `vitest`
// (`environment: "node"`), where every call transparently falls back to
// `node:fs/promises`.
//
// These are deliberately low-level (text read, JSON read, plain write) so the
// callers keep their own atomic-write orchestration (temp + rename + content
// compare in `LockedFileSystem`) and tolerant-read semantics (torn-shard skip,
// malformed-JSON error wrapping) byte-for-byte unchanged — only the underlying
// read/write engine swaps. Confirmed: Bun's `Bun.file().text()/.json()` reject
// with Node-style errno errors (`.code === "ENOENT"` etc.), so the callers'
// existing errno checks behave identically under either engine.

import { readFile, writeFile } from "node:fs/promises";

type FastFileEngine = "bun" | "fs";

let forcedEngine: FastFileEngine | null = null;

/**
 * Test-only override so a single `bun vitest` process can exercise BOTH engines
 * against the same assertions (proving equivalence). `null` restores auto-detect.
 */
export function __setFastFileEngineForTest(engine: FastFileEngine | null): void {
	forcedEngine = engine;
}

/** Which engine is currently active (respects the test override). */
export function activeFastFileEngine(): FastFileEngine {
	if (forcedEngine !== null) {
		return forcedEngine;
	}
	const bun = (globalThis as { Bun?: { file?: unknown; write?: unknown } }).Bun;
	return typeof bun?.file === "function" && typeof bun?.write === "function" ? "bun" : "fs";
}

function isErrnoException(error: unknown, code: string): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
	);
}

function isEnoent(error: unknown): boolean {
	return isErrnoException(error, "ENOENT");
}

/** An error carrying a string errno `code` (an IO failure, not a JSON parse error). */
function isFsLikeError(error: unknown): boolean {
	return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function malformedJsonError(path: string, error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Malformed JSON in ${path}. ${message}`);
}

/** Read a whole file as UTF-8 text, or `null` if it does not exist (ENOENT). */
export async function readTextFileOrNull(path: string): Promise<string | null> {
	try {
		if (activeFastFileEngine() === "bun") {
			return await Bun.file(path).text();
		}
		return await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
}

/**
 * Read a whole file as UTF-8 text. Throws (including ENOENT) — for callers that
 * have already established the file exists (e.g. a just-listed shard).
 */
export async function readTextFile(path: string): Promise<string> {
	if (activeFastFileEngine() === "bun") {
		return await Bun.file(path).text();
	}
	return await readFile(path, "utf8");
}

/**
 * Read and parse a JSON file. Returns `null` on ENOENT (missing file) — note this
 * is indistinguishable from a file whose content is literally `null`, matching the
 * pre-existing `readFile` + `JSON.parse` callers that also collapsed both to `null`.
 * A parse failure throws `Malformed JSON in <path>. <detail>` (path preserved for
 * diagnostics); a non-ENOENT IO error propagates untouched.
 */
export async function readJsonFileOrNull(path: string): Promise<unknown | null> {
	if (activeFastFileEngine() === "bun") {
		try {
			return await Bun.file(path).json();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			// A read failure carries an errno code; a JSON parse failure (SyntaxError)
			// does not — only the latter becomes a "Malformed JSON" error.
			if (isFsLikeError(error)) {
				throw error;
			}
			throw malformedJsonError(path, error);
		}
	}
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		throw malformedJsonError(path, error);
	}
}

/** Write UTF-8 text to a file (plain, non-atomic — atomic orchestration lives in the caller). */
export async function writeFileText(path: string, content: string): Promise<void> {
	if (activeFastFileEngine() === "bun") {
		await Bun.write(path, content);
		return;
	}
	await writeFile(path, content, "utf8");
}

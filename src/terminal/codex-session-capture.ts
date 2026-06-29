// Post-launch Codex session-id capture.
//
// Unlike Claude (which accepts a Kanban-minted `--session-id` at launch), the
// interactive `codex` command allocates its own conversation id at startup and
// only exposes it through the rollout file it writes to
// `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`. The first
// line of that file is a `session_meta` record carrying the canonical `id` and
// the session `cwd`.
//
// To resume a Codex conversation after a Kanban restart we therefore capture the
// id *after* launch: poll the sessions directory for the newest rollout whose
// `cwd` matches the task's worktree, and persist that id onto the session
// summary. Resuming with `codex resume <id>` re-attaches to it. Capturing on
// every launch (not just the first) makes this self-healing — whether Codex
// reuses the id or mints a fresh one on resume, we always re-capture the active
// conversation's id.
//
// Disambiguation relies on `cwd`: each task runs in its own worktree, so even
// when several tasks share the default `~/.codex/sessions` (official login, no
// custom provider) their rollouts never collide. The `sinceMs` floor guards
// against picking up a stale rollout from a *previous* launch of the same task
// before the current launch has written anything.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createLogger } from "../logging";

const log = createLogger("codex-session-capture");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// File-system mtime can lag the wall-clock `startedAt` by a small amount
// (rounding, clock skew). Allow a little slack so a rollout written essentially
// at launch time is not rejected by the `sinceMs` floor.
const MTIME_FLOOR_TOLERANCE_MS = 2_000;

const DEFAULT_CAPTURE_ATTEMPTS = 30;
const DEFAULT_CAPTURE_INTERVAL_MS = 500;

/**
 * Resolve the directory Codex writes session rollout files into. Mirrors Codex's
 * own resolution: an explicit `CODEX_HOME` (the isolated one Kanban projects for
 * a custom provider), else `process.env.CODEX_HOME`, else `~/.codex`.
 */
export function resolveCodexSessionsDir(codexHome: string | null | undefined): string {
	const home = codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
	return join(home, "sessions");
}

interface SessionMeta {
	id: string;
	cwd: string;
}

/** Read and parse the leading `session_meta` line of a rollout file. */
async function readRolloutSessionMeta(file: string): Promise<SessionMeta | null> {
	let firstLine: string | null = null;
	try {
		const stream = createReadStream(file, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of rl) {
				firstLine = line;
				break;
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	} catch {
		return null;
	}
	if (!firstLine) {
		return null;
	}
	try {
		const parsed = JSON.parse(firstLine) as {
			type?: unknown;
			payload?: { id?: unknown; cwd?: unknown };
		};
		if (parsed.type !== "session_meta") {
			return null;
		}
		const id = parsed.payload?.id;
		const cwd = parsed.payload?.cwd;
		if (typeof id !== "string" || !UUID_PATTERN.test(id) || typeof cwd !== "string") {
			return null;
		}
		return { id, cwd };
	} catch {
		return null;
	}
}

/** Recursively collect every `rollout-*.jsonl` file under a sessions directory. */
async function collectRolloutFiles(sessionsDir: string): Promise<string[]> {
	let entries: Array<{ name: string; parentPath?: string; path?: string }>;
	try {
		entries = (await readdir(sessionsDir, {
			recursive: true,
			withFileTypes: true,
		})) as unknown as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>;
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>) {
		if (!entry.isFile()) {
			continue;
		}
		if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
			continue;
		}
		// `parentPath` (Node 20.12+/Bun) is the directory holding the entry; older
		// `path` is the same. Fall back to the root when neither is present.
		const parent = entry.parentPath ?? entry.path ?? sessionsDir;
		files.push(join(parent, entry.name));
	}
	return files;
}

export interface FindLatestCodexSessionInput {
	/** The Codex sessions directory to scan (see {@link resolveCodexSessionsDir}). */
	sessionsDir: string;
	/** The task worktree cwd that identifies this session's rollout. */
	cwd: string;
	/** Ignore rollouts modified before this epoch-ms floor (the launch time). */
	sinceMs: number;
}

export interface LatestCodexRollout {
	/** Absolute path to the matching rollout `*.jsonl` file. */
	file: string;
	/** The rollout's canonical session id (from its `session_meta` line). */
	id: string;
}

/**
 * Find the most recently modified rollout under `sessionsDir` whose `cwd` matches
 * and whose mtime is at/after `sinceMs`. Returns its file path + session id, or
 * null when none qualifies. This is the shared cwd-matching locator behind both
 * session-id capture and token-usage reading — the worktree `cwd` disambiguates
 * concurrent sessions sharing a `~/.codex` default login (each task = one cwd).
 */
export async function findLatestCodexRollout(input: FindLatestCodexSessionInput): Promise<LatestCodexRollout | null> {
	const files = await collectRolloutFiles(input.sessionsDir);
	const floor = input.sinceMs - MTIME_FLOOR_TOLERANCE_MS;

	// Stat all candidates (cheap), drop those below the mtime floor, then sort by
	// mtime descending. The active rollout is the most recently written one, so
	// reading `session_meta` newest-first and returning at the first cwd match means
	// we usually open exactly one rollout instead of every file whose mtime beat the
	// running max — turning the per-walk `session_meta` reads from O(files) into ≈1
	// (finding T1). The cwd disambiguates concurrent sessions sharing `~/.codex`.
	const candidates: Array<{ file: string; mtimeMs: number }> = [];
	for (const file of files) {
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(file)).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < floor) {
			continue;
		}
		candidates.push({ file, mtimeMs });
	}
	candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

	for (const candidate of candidates) {
		const meta = await readRolloutSessionMeta(candidate.file);
		if (!meta || meta.cwd !== input.cwd) {
			continue;
		}
		return { file: candidate.file, id: meta.id };
	}
	return null;
}

/**
 * Find the session id of the most recently modified rollout under `sessionsDir`
 * whose `cwd` matches and whose mtime is at/after `sinceMs`. Returns null when
 * none qualifies.
 */
export async function findLatestCodexSessionId(input: FindLatestCodexSessionInput): Promise<string | null> {
	return (await findLatestCodexRollout(input))?.id ?? null;
}

export interface CaptureCodexSessionOptions {
	/** Number of poll attempts before giving up. */
	attempts?: number;
	/** Delay between poll attempts in ms. */
	intervalMs?: number;
	/** Injectable sleep, for tests. */
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for the rollout of a freshly launched (or resumed) Codex session and
 * return its id once it appears. Returns null if it never shows up within the
 * configured attempts.
 */
export async function captureCodexSessionId(
	input: FindLatestCodexSessionInput,
	options?: CaptureCodexSessionOptions,
): Promise<string | null> {
	const attempts = options?.attempts ?? DEFAULT_CAPTURE_ATTEMPTS;
	const intervalMs = options?.intervalMs ?? DEFAULT_CAPTURE_INTERVAL_MS;
	const sleep = options?.sleep ?? defaultSleep;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const id = await findLatestCodexSessionId(input);
		if (id) {
			return id;
		}
		if (attempt < attempts - 1) {
			await sleep(intervalMs);
		}
	}
	log.debug("No Codex rollout captured for session", { sessionsDir: input.sessionsDir, cwd: input.cwd });
	return null;
}

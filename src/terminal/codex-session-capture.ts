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

import { createReadStream, type Dirent } from "node:fs";
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

/** True for a Codex rollout transcript filename (`rollout-*.jsonl`). */
function isRolloutFileName(name: string): boolean {
	return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** Read a directory's immediate entries, returning `[]` when it can't be read. */
async function readDirEntriesSafe(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * Names of a directory's immediate child dirs that look like a zero-padded numeric
 * date segment (`2026`, `06`, `22`), sorted **descending**. Codex pads every level
 * to a fixed width, so a lexical descending sort equals a numeric one and a
 * non-date sibling (e.g. an index dir) is filtered out.
 */
function numericChildDirsDescending(entries: Dirent[]): string[] {
	return entries
		.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
		.map((entry) => entry.name)
		.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
}

/**
 * Yield the `<YYYY>/<MM>/<DD>` rollout day-directories under a Codex sessions dir,
 * **newest date first**. Codex partitions rollouts by creation date, so descending
 * the numeric year→month→day levels visits the most recent days first. The traversal
 * is lazy — each level is only read when the consumer pulls past the previous one —
 * so an early-exiting caller (which is the common case: the active session's rollout
 * is in one of the newest day-dirs) reads only recent history instead of recursively
 * stat-ing every rollout the user has ever created (finding T1).
 */
async function* iterRolloutDayDirsNewestFirst(sessionsDir: string): AsyncGenerator<string> {
	for (const year of numericChildDirsDescending(await readDirEntriesSafe(sessionsDir))) {
		const yearDir = join(sessionsDir, year);
		for (const month of numericChildDirsDescending(await readDirEntriesSafe(yearDir))) {
			const monthDir = join(yearDir, month);
			for (const day of numericChildDirsDescending(await readDirEntriesSafe(monthDir))) {
				yield join(monthDir, day);
			}
		}
	}
}

/**
 * Among accumulated candidates, return the highest-mtime one whose rollout `cwd`
 * matches, or null. `session_meta` reads are memoized in `metaCache` so re-scanning
 * a growing candidate set across day-dirs never re-reads a file's first line.
 */
async function resolveHighestMtimeCwdMatch(
	candidates: Array<{ file: string; mtimeMs: number }>,
	cwd: string,
	metaCache: Map<string, SessionMeta | null>,
): Promise<LatestCodexRollout | null> {
	const sorted = [...candidates].sort((left, right) => right.mtimeMs - left.mtimeMs);
	for (const candidate of sorted) {
		let meta = metaCache.get(candidate.file);
		if (meta === undefined) {
			meta = await readRolloutSessionMeta(candidate.file);
			metaCache.set(candidate.file, meta);
		}
		if (meta && meta.cwd === cwd) {
			return { file: candidate.file, id: meta.id };
		}
	}
	return null;
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
 * Find the active rollout under `sessionsDir` whose `cwd` matches and whose mtime is
 * at/after `sinceMs`. Returns its file path + session id, or null when none qualifies.
 * This is the shared cwd-matching locator behind both session-id capture and
 * token-usage reading — the worktree `cwd` disambiguates concurrent sessions sharing
 * a `~/.codex` default login (each task = one cwd).
 *
 * Resolution is **newest-date-dir first, highest-mtime within** (finding T1): the walk
 * stops at the first `<YYYY>/<MM>/<DD>` dir that yields a cwd match rather than stat-ing
 * the user's whole history. The only deviation from a strict global-max-mtime scan is
 * the narrow case where the *same* cwd has rollouts across multiple days and an
 * older-dated one was resume-appended more recently than a newer-dated one — then the
 * newer-dated rollout wins. On the capture path the `sinceMs` floor excludes that stale
 * newer-dated rollout, so capture stays exact; on the usage path (no floor) it self-heals
 * because the resolved path is dropped and re-resolved on the next launch.
 */
export async function findLatestCodexRollout(input: FindLatestCodexSessionInput): Promise<LatestCodexRollout | null> {
	const floor = input.sinceMs - MTIME_FLOOR_TOLERANCE_MS;

	// Walk day-directories newest-date-first and stop at the first day that yields a
	// cwd match. The active session's rollout lives in (one of) the most recent
	// day-dirs, so this reads only recent history instead of stat-ing every rollout
	// the user has ever created (finding T1) — the win is largest on the launch
	// capture poll, which repeats this walk up to 30×. Within the accumulated
	// candidate set we still return the highest-mtime cwd match, so a single day
	// holding several same-cwd rollouts resolves to the most recently written one,
	// and a newest day with no match falls through to older days. The `sinceMs` floor
	// drops rollouts from a previous launch (and, on the capture path, makes the
	// date-first early-exit exact — a stale newer-dated rollout sits below the floor).
	const candidates: Array<{ file: string; mtimeMs: number }> = [];
	const metaCache = new Map<string, SessionMeta | null>();

	for await (const dayDir of iterRolloutDayDirsNewestFirst(input.sessionsDir)) {
		let addedFromThisDay = false;
		for (const entry of await readDirEntriesSafe(dayDir)) {
			if (!entry.isFile() || !isRolloutFileName(entry.name)) {
				continue;
			}
			const file = join(dayDir, entry.name);
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
			addedFromThisDay = true;
		}
		if (!addedFromThisDay) {
			continue;
		}
		const match = await resolveHighestMtimeCwdMatch(candidates, input.cwd, metaCache);
		if (match) {
			return match;
		}
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

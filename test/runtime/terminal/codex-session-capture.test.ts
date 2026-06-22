import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	captureCodexSessionId,
	findLatestCodexSessionId,
	resolveCodexSessionsDir,
} from "../../../src/terminal/codex-session-capture";

let tempRoot: string | null = null;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "kanban-codex-capture-"));
});

afterEach(() => {
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	tempRoot = null;
});

function sessionsDir(): string {
	return join(tempRoot ?? "", "sessions");
}

/** Write a Codex rollout file mirroring the real on-disk shape and return its path. */
function writeRollout(opts: {
	sessionId: string;
	cwd: string;
	/** Path date segments, e.g. ["2026", "06", "22"]. */
	date?: [string, string, string];
	/** mtime in epoch ms (defaults to now). */
	mtimeMs?: number;
	/** Override the file's leading line; defaults to a valid session_meta line. */
	firstLine?: string;
}): string {
	const [yyyy, mm, dd] = opts.date ?? ["2026", "06", "22"];
	const dir = join(sessionsDir(), yyyy, mm, dd);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `rollout-${yyyy}-${mm}-${dd}T00-00-00-${opts.sessionId}.jsonl`);
	const firstLine =
		opts.firstLine ??
		JSON.stringify({
			timestamp: "2026-06-22T00:00:00.000Z",
			type: "session_meta",
			payload: { id: opts.sessionId, cwd: opts.cwd, originator: "codex-tui" },
		});
	// A second line of unrelated content to prove we only parse the first line.
	writeFileSync(file, `${firstLine}\n{"type":"event_msg","payload":{}}\n`);
	if (opts.mtimeMs !== undefined) {
		const seconds = opts.mtimeMs / 1000;
		utimesSync(file, seconds, seconds);
	}
	return file;
}

const ID_A = "019ddd7c-fe34-79c1-ba7e-408ca3103dff";
const ID_B = "019e15fb-8652-7af3-8a21-45e595ff68d9";

describe("resolveCodexSessionsDir", () => {
	it("appends /sessions to an explicit CODEX_HOME", () => {
		expect(resolveCodexSessionsDir("/custom/codex-home")).toBe(join("/custom/codex-home", "sessions"));
	});

	it("falls back to ~/.codex/sessions when no home is given", () => {
		const previous = process.env.CODEX_HOME;
		delete process.env.CODEX_HOME;
		try {
			expect(resolveCodexSessionsDir(null)).toBe(join(homedir(), ".codex", "sessions"));
		} finally {
			if (previous !== undefined) {
				process.env.CODEX_HOME = previous;
			}
		}
	});

	it("falls back to process.env.CODEX_HOME when no explicit home is given", () => {
		const previous = process.env.CODEX_HOME;
		process.env.CODEX_HOME = "/env/codex-home";
		try {
			expect(resolveCodexSessionsDir(undefined)).toBe(join("/env/codex-home", "sessions"));
		} finally {
			if (previous === undefined) {
				delete process.env.CODEX_HOME;
			} else {
				process.env.CODEX_HOME = previous;
			}
		}
	});
});

describe("findLatestCodexSessionId", () => {
	it("returns the session id of a rollout matching the task cwd", async () => {
		writeRollout({ sessionId: ID_A, cwd: "/repo/worktree-a" });
		const id = await findLatestCodexSessionId({ sessionsDir: sessionsDir(), cwd: "/repo/worktree-a", sinceMs: 0 });
		expect(id).toBe(ID_A);
	});

	it("ignores rollouts whose cwd does not match the task", async () => {
		writeRollout({ sessionId: ID_A, cwd: "/some/other/repo" });
		const id = await findLatestCodexSessionId({ sessionsDir: sessionsDir(), cwd: "/repo/worktree-a", sinceMs: 0 });
		expect(id).toBeNull();
	});

	it("returns the most recently modified matching rollout when several share a cwd", async () => {
		writeRollout({ sessionId: ID_A, cwd: "/repo/worktree-a", mtimeMs: 1_000_000 });
		writeRollout({ sessionId: ID_B, cwd: "/repo/worktree-a", mtimeMs: 2_000_000 });
		const id = await findLatestCodexSessionId({ sessionsDir: sessionsDir(), cwd: "/repo/worktree-a", sinceMs: 0 });
		expect(id).toBe(ID_B);
	});

	it("ignores a stale rollout from a previous launch older than sinceMs", async () => {
		writeRollout({ sessionId: ID_A, cwd: "/repo/worktree-a", mtimeMs: 1_000_000 });
		const id = await findLatestCodexSessionId({
			sessionsDir: sessionsDir(),
			cwd: "/repo/worktree-a",
			sinceMs: 5_000_000,
		});
		expect(id).toBeNull();
	});

	it("returns null when the sessions directory does not exist", async () => {
		const id = await findLatestCodexSessionId({
			sessionsDir: join(tempRoot ?? "", "missing"),
			cwd: "/repo/worktree-a",
			sinceMs: 0,
		});
		expect(id).toBeNull();
	});

	it("skips rollout files whose first line is not valid session_meta", async () => {
		writeRollout({ sessionId: ID_A, cwd: "/repo/worktree-a", firstLine: "not-json" });
		const id = await findLatestCodexSessionId({ sessionsDir: sessionsDir(), cwd: "/repo/worktree-a", sinceMs: 0 });
		expect(id).toBeNull();
	});
});

describe("captureCodexSessionId", () => {
	it("polls until the rollout file appears, then returns its id", async () => {
		let attempt = 0;
		const sleep = async () => {
			// Simulate Codex writing the rollout only after the first poll.
			attempt += 1;
			if (attempt === 1) {
				writeRollout({ sessionId: ID_A, cwd: "/repo/worktree-a" });
			}
		};
		const id = await captureCodexSessionId(
			{ sessionsDir: sessionsDir(), cwd: "/repo/worktree-a", sinceMs: 0 },
			{ attempts: 5, intervalMs: 1, sleep },
		);
		expect(id).toBe(ID_A);
		expect(attempt).toBe(1);
	});

	it("returns null when no matching rollout ever appears", async () => {
		const id = await captureCodexSessionId(
			{ sessionsDir: sessionsDir(), cwd: "/repo/worktree-a", sinceMs: 0 },
			{ attempts: 3, intervalMs: 1, sleep: async () => {} },
		);
		expect(id).toBeNull();
	});
});

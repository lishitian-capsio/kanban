import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createGitProcessEnv } from "../core/git-process-env";

const execFileAsync = promisify(execFile);

/**
 * Hard wall-clock cap for the local git probe. `rev-parse --is-inside-work-tree`
 * is a fast local read; a read that takes this long signals a genuinely wedged git
 * (lock contention, stalled network filesystem). Bound it and degrade to `false`
 * rather than leaving the caller pending.
 */
const GIT_CHECK_TIMEOUT_MS = 10_000;

/**
 * Async "is this path inside a git work tree?" probe.
 *
 * MUST stay async: this runs on the `addProject` hot path (and once at registry
 * launch). The previous `spawnSync` implementation blocked the entire Bun event
 * loop for the git subprocess's full duration — when git was wedged (a concurrent
 * `git worktree add` / board-sync holding the repo lock, the same contention that
 * caused the 88s hard freeze), `addProject` froze the whole runtime instead of
 * just that request. An `await`ed spawn keeps the loop breathing, so a slow git
 * degrades to a laggy (not frozen) probe. No github-auth/proxy injection here on
 * purpose — this is a purely local read.
 */
export async function isGitRepository(path: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: path,
			encoding: "utf8",
			env: createGitProcessEnv(),
			timeout: GIT_CHECK_TIMEOUT_MS,
		});
		return stdout.trim() === "true";
	} catch {
		// Non-zero exit (not a repo), timeout kill, or spawn failure — all "not a
		// usable git repository" from the caller's perspective.
		return false;
	}
}

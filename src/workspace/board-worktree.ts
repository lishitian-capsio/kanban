import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { BOARD_REF_FILENAME, DEFAULT_BOARD_BRANCH, readBoardRef } from "../state/board-ref";
import { getGitStdout, runGit } from "./git-utils";
import {
	BOARD_WORKTREE_SENTINEL,
	getWorkspaceFolderLabelForWorktreePath,
	KANBAN_RUNTIME_HOME_DIR_NAME,
	KANBAN_TASK_WORKTREES_DIR_NAME,
} from "./task-worktree-path";

const log = createLogger("board-worktree");

const BOARD_WORKTREE_SETUP_LOCKFILE_NAME = "kanban-board-worktree-setup.lock";

/**
 * Hard cap for a single network git op (push / fetch) on the board branch. Push and pull
 * are user-triggered and serialized per repo; this bound guarantees a stalled connection or
 * a credential prompt can't hang the work queue indefinitely. On expiry the git child is
 * killed and the op reports failure (surfaced, never auto-retried).
 */
const BOARD_NETWORK_GIT_TIMEOUT_MS = 30_000;

// Dedicated identity for the parentless initial commit of an orphan board branch,
// mirroring the checkpoint identity in turn-checkpoints.ts. Also used for the
// machine-authored code-branch decoupling commit so it never fails on a repo with
// no configured `user.name`/`user.email`.
const BOARD_AUTHOR_NAME = "kanban-board";
const BOARD_AUTHOR_EMAIL = "kanban-board@local";

/** Root `.gitignore` on the *code* branch — gains the `/.kanban/*` flip on decouple. */
const ROOT_GITIGNORE_FILENAME = ".gitignore";

/** `.kanban/board-ref`, the single code-branch-tracked artifact kept across the flip. */
const BOARD_REF_REPO_RELATIVE_PATH = `${KANBAN_RUNTIME_HOME_DIR_NAME}/${BOARD_REF_FILENAME}`;

const DECOUPLE_COMMIT_MESSAGE = "chore(kanban): decouple board data to its own branch";

const BOARD_REF_UPDATE_COMMIT_MESSAGE = "chore(kanban): point board-ref at the renamed board branch";

export interface EnsureBoardWorktreeResult {
	ok: boolean;
	/** Absolute worktree path, or `null` when decoupling is inactive / setup failed. */
	path: string | null;
	/** Branch the worktree tracks, or `null` when decoupling is inactive. */
	branch: string | null;
	/** True only when this call created the worktree (false on the idempotent reuse path). */
	created: boolean;
	error?: string;
}

/** The `worktrees/__board__/` root that holds the board worktree (gitignored on the code branch). */
export function getBoardWorktreesRootPath(repoPath: string): string {
	return join(repoPath, KANBAN_RUNTIME_HOME_DIR_NAME, KANBAN_TASK_WORKTREES_DIR_NAME, BOARD_WORKTREE_SENTINEL);
}

/** The board worktree directory: `<repo>/.kanban/worktrees/__board__/<workspace-label>`. */
export function getBoardWorktreePath(repoPath: string): string {
	return join(getBoardWorktreesRootPath(repoPath), getWorkspaceFolderLabelForWorktreePath(repoPath));
}

/**
 * The committed board-data root inside the board worktree: `<boardWorktree>/.kanban`.
 * Mirrors the single-root layout (`workspaces/<id>/...`, `files/...`) so every
 * committed-data path derivation works unchanged once the root is repointed here.
 */
export function getBoardWorktreeDataHome(repoPath: string): string {
	return join(getBoardWorktreePath(repoPath), KANBAN_RUNTIME_HOME_DIR_NAME);
}

function buildBoardCommitEnv(): NodeJS.ProcessEnv {
	return {
		...createGitProcessEnv(),
		GIT_AUTHOR_NAME: BOARD_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: BOARD_AUTHOR_EMAIL,
		GIT_COMMITTER_NAME: BOARD_AUTHOR_NAME,
		GIT_COMMITTER_EMAIL: BOARD_AUTHOR_EMAIL,
	};
}

async function getGitCommonDir(repoPath: string): Promise<string> {
	const gitCommonDir = await getGitStdout(["rev-parse", "--git-common-dir"], repoPath);
	return isAbsolute(gitCommonDir) ? gitCommonDir : join(repoPath, gitCommonDir);
}

async function getBoardWorktreeSetupLock(repoPath: string): Promise<LockRequest> {
	return {
		path: await getGitCommonDir(repoPath),
		type: "directory",
		lockfileName: BOARD_WORKTREE_SETUP_LOCKFILE_NAME,
	};
}

async function isGitWorktree(path: string): Promise<boolean> {
	// `--is-inside-work-tree` succeeds even for an unborn (no-commit) orphan branch,
	// where `rev-parse HEAD` would fail, so it is the right liveness probe here.
	const result = await runGit(path, ["rev-parse", "--is-inside-work-tree"]);
	return result.ok && result.stdout === "true";
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
	const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	return result.ok;
}

/** The first configured remote (origin when present), or null for a remote-less repo. */
async function getDefaultRemote(repoPath: string): Promise<string | null> {
	const result = await runGit(repoPath, ["remote"]);
	if (!result.ok || !result.stdout) {
		return null;
	}
	const remotes = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (remotes.length === 0) {
		return null;
	}
	return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
}

async function remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean> {
	const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
	return result.ok;
}

/**
 * Fetch `<remote>/<branch>` into the local remote-tracking ref using an explicit
 * refspec, so `refs/remotes/<remote>/<branch>` is always updated regardless of how
 * the remote's default fetch refspec is configured (a manually-added remote may have
 * none). Returns false when the fetch failed (e.g. offline / branch absent on remote).
 */
async function fetchBoardBranchIntoTrackingRef(worktreePath: string, remote: string, branch: string): Promise<boolean> {
	const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
	const result = await runGit(worktreePath, ["fetch", remote, refspec], {
		env: buildBoardCommitEnv(),
		timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
	});
	return result.ok;
}

/** Is `HEAD` strictly behind `<remote>/<branch>` (i.e. a clean fast-forward is possible)? */
async function isHeadBehindRemote(worktreePath: string, remote: string, branch: string): Promise<boolean> {
	const remoteRef = `refs/remotes/${remote}/${branch}`;
	// HEAD must be a strict ancestor of the remote ref to fast-forward...
	const isAncestor = await runGit(worktreePath, ["merge-base", "--is-ancestor", "HEAD", remoteRef]);
	if (!isAncestor.ok) {
		return false;
	}
	// ...and they must not already be equal (nothing to do).
	const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
	const remoteHead = await runGit(worktreePath, ["rev-parse", remoteRef]);
	return head.ok && remoteHead.ok && head.stdout !== remoteHead.stdout;
}

/**
 * Did a `git fetch <remote> <branch>` fail because the remote genuinely has no such
 * branch (vs. a network/connection failure)? Git prints "couldn't find remote ref
 * <branch>" for the former; an unreachable remote, a timeout SIGKILL, or a bad URL
 * produce other messages. Used to keep the legitimate brand-new-project degradation
 * (orphan an empty branch) distinct from a transient failure that must not mask data.
 */
function isMissingRemoteRefError(fetchOutput: string): boolean {
	return fetchOutput.toLowerCase().includes("find remote ref");
}

function isNonFastForwardRejection(pushOutput: string): boolean {
	const lowered = pushOutput.toLowerCase();
	return (
		lowered.includes("non-fast-forward") ||
		lowered.includes("fetch first") ||
		lowered.includes("updates were rejected") ||
		lowered.includes("[rejected]")
	);
}

/** Outcome of a board worktree push attempt. */
export type BoardPushStatus =
	/** Pushed cleanly (local was ahead, remote fast-forwarded). */
	| "pushed"
	/** Remote had moved; its commits were merged in locally, then pushed. */
	| "integrated-and-pushed"
	/** Nothing to push (no local commits ahead of the remote). */
	| "up-to-date"
	/** No remote is configured; the board branch is local-only (still durable in .git). */
	| "no-remote"
	/** Remote and local diverged with a content conflict; surfaced, NOT auto-resolved. */
	| "conflict"
	/** Push or fetch failed for another reason (e.g. offline); retried on the next sync. */
	| "error";

export interface BoardPushResult {
	status: BoardPushStatus;
	/** True when integrating the remote changed the local working tree (callers reload + rebroadcast). */
	pulledChanges: boolean;
	error?: string;
}

/**
 * Push the board branch to its remote, reconciling a remote that has moved on.
 *
 * The happy path is a plain fast-forward push. When the remote rejects it as
 * non-fast-forward (another machine pushed first), we fetch and `merge` the remote
 * into the local board branch: sharding makes most concurrent edits (different task
 * files, layout-only `board.json`) merge cleanly, after which we re-push. A genuine
 * content conflict (same task / same layout edited on both sides) is **surfaced, not
 * auto-resolved** — we `merge --abort` to leave the runtime-exclusive worktree clean
 * (conflict markers would corrupt the next shard read) and report `"conflict"`; the
 * local commits stay intact and durable, and the next sync retries. See
 * `.plan/docs/board-branch-decoupling.md` §3.7 / §4(5).
 */
export async function pushBoardWorktree(repoPath: string, branch: string): Promise<BoardPushResult> {
	const worktreePath = getBoardWorktreePath(repoPath);
	const remote = await getDefaultRemote(repoPath);
	if (!remote) {
		return { status: "no-remote", pulledChanges: false };
	}

	const push = await runGit(worktreePath, ["push", remote, `${branch}:${branch}`], {
		env: buildBoardCommitEnv(),
		timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
	});
	if (push.ok) {
		// `Everything up-to-date` means there was nothing ahead to publish.
		const status: BoardPushStatus = push.output.toLowerCase().includes("up-to-date") ? "up-to-date" : "pushed";
		return { status, pulledChanges: false };
	}
	if (!isNonFastForwardRejection(push.output)) {
		log.warn("board push failed", { repoPath, branch, remote, output: push.output });
		return { status: "error", pulledChanges: false, error: push.error ?? push.output };
	}

	// Remote moved ahead — bring it in, then re-push.
	if (!(await fetchBoardBranchIntoTrackingRef(worktreePath, remote, branch))) {
		return {
			status: "error",
			pulledChanges: false,
			error: "Could not fetch the board branch to reconcile a rejected push.",
		};
	}
	const merge = await runGit(worktreePath, ["merge", "--no-edit", `refs/remotes/${remote}/${branch}`], {
		env: buildBoardCommitEnv(),
	});
	if (!merge.ok) {
		// Surface the conflict without destroying data: abort restores the pre-merge
		// state (local commits intact); resolution is left to the user (UI lands in P4).
		await runGit(worktreePath, ["merge", "--abort"], { env: buildBoardCommitEnv() });
		log.warn("board push hit a merge conflict; left local data intact and surfaced the conflict", {
			repoPath,
			branch,
			remote,
		});
		return { status: "conflict", pulledChanges: false, error: merge.output };
	}

	const rePush = await runGit(worktreePath, ["push", remote, `${branch}:${branch}`], {
		env: buildBoardCommitEnv(),
		timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
	});
	if (!rePush.ok) {
		return { status: "error", pulledChanges: true, error: rePush.error ?? rePush.output };
	}
	return { status: "integrated-and-pushed", pulledChanges: true };
}

/**
 * Fetch the board branch and fast-forward the worktree to the remote tip when the
 * worktree is strictly behind (another machine pushed while this one was offline).
 * Never merges or rewrites — a divergence is left for the push path to reconcile.
 * Returns `{ changed: true }` only when the fast-forward moved HEAD, so the caller
 * knows to reload + rebroadcast the board.
 *
 * CURRENTLY UNUSED by the runtime: the board-sync redesign (auto commit + explicit
 * push/pull, `.plan/docs/board-sync-redesign.md`) removed the boot reconcile that was
 * its only caller — startup no longer touches the network. Kept (and still unit-tested)
 * as the building block for any future opt-in boot reconcile.
 */
export async function fetchAndFastForwardBoardWorktree(
	repoPath: string,
	branch: string,
): Promise<{ changed: boolean }> {
	const worktreePath = getBoardWorktreePath(repoPath);
	const remote = await getDefaultRemote(repoPath);
	if (!remote) {
		return { changed: false };
	}
	if (!(await fetchBoardBranchIntoTrackingRef(worktreePath, remote, branch))) {
		return { changed: false };
	}
	if (!(await isHeadBehindRemote(worktreePath, remote, branch))) {
		return { changed: false };
	}
	const ff = await runGit(worktreePath, ["merge", "--ff-only", `refs/remotes/${remote}/${branch}`], {
		env: buildBoardCommitEnv(),
	});
	return { changed: ff.ok };
}

/** Tag prefix anchoring the pre-rename tip of an old board branch, for rollback. */
const BOARD_ARCHIVE_TAG_PREFIX = "kanban/board-archive";

export interface BoardAheadBehind {
	/** Whether the board worktree itself exists on disk. */
	exists: boolean;
	/** Whether a git remote is configured. */
	hasRemote: boolean;
	/** Whether the remote-tracking ref for the board branch is present (post-fetch). */
	hasRemoteRef: boolean;
	aheadCount: number;
	behindCount: number;
}

/**
 * Compute how far the board worktree is ahead of / behind its remote, using the
 * **last-known** remote-tracking ref — this is a cheap, fetch-free read for the
 * status badge. A fetch (and thus a refreshed `behindCount`) happens on the
 * startup reconcile, a push reconcile, or an explicit pull. Never throws: any git
 * failure degrades to zero counts.
 */
export async function getBoardWorktreeAheadBehind(repoPath: string, branch: string): Promise<BoardAheadBehind> {
	const worktreePath = getBoardWorktreePath(repoPath);
	if (!(await isGitWorktree(worktreePath))) {
		return { exists: false, hasRemote: false, hasRemoteRef: false, aheadCount: 0, behindCount: 0 };
	}
	const remote = await getDefaultRemote(repoPath);
	if (!remote) {
		return { exists: true, hasRemote: false, hasRemoteRef: false, aheadCount: 0, behindCount: 0 };
	}
	const remoteRef = `refs/remotes/${remote}/${branch}`;
	if (!(await remoteBranchExists(repoPath, remote, branch))) {
		return { exists: true, hasRemote: true, hasRemoteRef: false, aheadCount: 0, behindCount: 0 };
	}
	const counts = await runGit(worktreePath, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`]);
	if (!counts.ok) {
		return { exists: true, hasRemote: true, hasRemoteRef: true, aheadCount: 0, behindCount: 0 };
	}
	const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/, 2);
	const aheadCount = Number.parseInt(aheadRaw ?? "0", 10);
	const behindCount = Number.parseInt(behindRaw ?? "0", 10);
	return {
		exists: true,
		hasRemote: true,
		hasRemoteRef: true,
		aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
		behindCount: Number.isFinite(behindCount) ? behindCount : 0,
	};
}

export interface BoardPullResult {
	status: "pulled" | "up-to-date" | "no-remote" | "conflict" | "error";
	/** True when the pull moved local HEAD (callers reload + rebroadcast). */
	pulledChanges: boolean;
	error?: string;
}

/**
 * Explicit pull: fetch the board branch and merge the remote into the local
 * worktree. Fast-forwards when only behind; creates a merge commit when diverged
 * (sharding keeps most concurrent edits conflict-free). A genuine content conflict
 * is **surfaced, not auto-resolved** — the merge is aborted to keep the worktree
 * clean (conflict markers would corrupt the next shard read) and `"conflict"` is
 * returned with local data intact. The manual counterpart to the push path's
 * remote reconciliation; see §4(5).
 */
export async function pullBoardWorktree(repoPath: string, branch: string): Promise<BoardPullResult> {
	const worktreePath = getBoardWorktreePath(repoPath);
	const remote = await getDefaultRemote(repoPath);
	if (!remote) {
		return { status: "no-remote", pulledChanges: false };
	}
	if (!(await fetchBoardBranchIntoTrackingRef(worktreePath, remote, branch))) {
		return { status: "error", pulledChanges: false, error: "Could not fetch the board branch." };
	}
	if (!(await remoteBranchExists(repoPath, remote, branch))) {
		// Remote has no such branch yet (we are the first to publish it) — nothing to pull.
		return { status: "up-to-date", pulledChanges: false };
	}
	const remoteRef = `refs/remotes/${remote}/${branch}`;
	const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
	const remoteHead = await runGit(worktreePath, ["rev-parse", remoteRef]);
	if (head.ok && remoteHead.ok && head.stdout === remoteHead.stdout) {
		return { status: "up-to-date", pulledChanges: false };
	}
	const merge = await runGit(worktreePath, ["merge", "--no-edit", remoteRef], { env: buildBoardCommitEnv() });
	if (!merge.ok) {
		await runGit(worktreePath, ["merge", "--abort"], { env: buildBoardCommitEnv() });
		log.warn("board pull hit a merge conflict; left local data intact and surfaced the conflict", {
			repoPath,
			branch,
			remote,
		});
		return { status: "conflict", pulledChanges: false, error: merge.output };
	}
	return { status: "pulled", pulledChanges: true };
}

export interface RenameBoardBranchResult {
	ok: boolean;
	/** Archive tag left as a rollback anchor for the old branch, when created. */
	archivedTag: string | null;
	error?: string;
}

async function rollbackBoardBranchRename(
	repoPath: string,
	worktreePath: string,
	oldBranch: string,
	newBranch: string,
	archiveTag: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	// Return to the old branch and undo the half-applied local rename so the next
	// attempt (and the still-authoritative board-ref) finds a clean old branch.
	await runGit(worktreePath, ["switch", oldBranch], { env });
	await runGit(repoPath, ["branch", "-D", newBranch], { env });
	await runGit(repoPath, ["tag", "-d", archiveTag], { env });
}

/**
 * Rename the board branch **without ever abandoning data** (§4(4)). The new branch
 * is created from the old branch's tip (history + data carried over), the board
 * worktree is switched onto it, an archive tag is left on the old tip as a rollback
 * anchor, then — when a remote exists — the new branch is pushed and the old one
 * deleted on the remote. Any failure rolls back to the old branch and leaves the
 * authoritative `.kanban/board-ref` untouched (the orchestrator only rewrites the
 * pointer after this returns ok), so the board never goes empty. A no-op (ok) when
 * the names already match.
 */
export async function renameBoardBranch(
	repoPath: string,
	oldBranch: string,
	newBranch: string,
): Promise<RenameBoardBranchResult> {
	const trimmedNew = newBranch.trim();
	if (!trimmedNew) {
		return { ok: false, archivedTag: null, error: "Branch name cannot be empty." };
	}
	if (trimmedNew === oldBranch) {
		return { ok: true, archivedTag: null };
	}
	const validFormat = await runGit(repoPath, ["check-ref-format", `refs/heads/${trimmedNew}`]);
	if (!validFormat.ok) {
		return { ok: false, archivedTag: null, error: `Invalid branch name: ${trimmedNew}` };
	}

	const worktreePath = getBoardWorktreePath(repoPath);
	if (!(await isGitWorktree(worktreePath))) {
		return { ok: false, archivedTag: null, error: "The board worktree is not set up." };
	}
	const current = await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const currentBranch = current.ok ? current.stdout : null;
	if (currentBranch !== oldBranch) {
		return {
			ok: false,
			archivedTag: null,
			error: `The board worktree is on '${currentBranch ?? "detached HEAD"}', not the expected '${oldBranch}'.`,
		};
	}
	if (await branchExists(repoPath, trimmedNew)) {
		return { ok: false, archivedTag: null, error: `A branch named '${trimmedNew}' already exists.` };
	}

	const env = buildBoardCommitEnv();

	// ① New branch at the old tip — data and history come along.
	const created = await runGit(repoPath, ["branch", trimmedNew, oldBranch], { env });
	if (!created.ok) {
		return { ok: false, archivedTag: null, error: created.error ?? created.output };
	}

	// ② Move the worktree onto the new branch.
	const switched = await runGit(worktreePath, ["switch", trimmedNew], { env });
	if (!switched.ok) {
		await runGit(repoPath, ["branch", "-D", trimmedNew], { env });
		return { ok: false, archivedTag: null, error: switched.error ?? switched.output };
	}

	// ③ Archive the old tip so the rename is reversible even after the old branch is gone.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const archiveTag = `${BOARD_ARCHIVE_TAG_PREFIX}/${stamp}`;
	await runGit(repoPath, ["tag", archiveTag, oldBranch], { env });

	// ④ Publish the new branch, then retire the old one on the remote.
	const remote = await getDefaultRemote(repoPath);
	if (remote) {
		const pushNew = await runGit(worktreePath, ["push", remote, `${trimmedNew}:${trimmedNew}`], {
			env,
			timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
		});
		if (!pushNew.ok) {
			await rollbackBoardBranchRename(repoPath, worktreePath, oldBranch, trimmedNew, archiveTag, env);
			return { ok: false, archivedTag: null, error: pushNew.error ?? pushNew.output };
		}
		// Best-effort: the archive tag and old-branch deletion are cleanup, not gates —
		// the rename is already live once the new branch is pushed.
		await runGit(worktreePath, ["push", remote, `refs/tags/${archiveTag}`], {
			env,
			timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
		});
		const deleteOld = await runGit(worktreePath, ["push", remote, `:${oldBranch}`], {
			env,
			timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
		});
		if (!deleteOld.ok) {
			log.warn("renamed the board branch but could not delete the old branch on the remote", {
				repoPath,
				oldBranch,
				newBranch: trimmedNew,
				remote,
			});
		}
	}

	// The archive tag preserves the tip, so the local old branch can be retired too.
	await runGit(repoPath, ["branch", "-D", oldBranch], { env });
	return { ok: true, archivedTag: archiveTag };
}

/**
 * Create an orphan board branch without a worktree, using plumbing only so it
 * works on any git version (the porcelain `git worktree add --orphan` needs git
 * ≥ 2.42 and its flag spelling has drifted across releases — see §6). The branch
 * is rooted at a single parentless commit of the empty tree; the board worktree
 * is then checked out onto it. Returns the created commit oid.
 */
export async function createOrphanBranchViaPlumbing(repoPath: string, branch: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "kanban-board-orphan-"));
	const env: NodeJS.ProcessEnv = {
		...buildBoardCommitEnv(),
		GIT_INDEX_FILE: join(tempDir, "index"),
	};
	try {
		// Empty index → empty tree oid (hash-algorithm agnostic, unlike a hardcoded SHA).
		await getGitStdout(["read-tree", "--empty"], repoPath, { env });
		const treeOid = await getGitStdout(["write-tree"], repoPath, { env });
		const commitOid = await getGitStdout(["commit-tree", treeOid, "-m", "board: initialize board branch"], repoPath, {
			env,
		});
		await getGitStdout(["branch", branch, commitOid], repoPath, { env });
		return commitOid;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function createBoardWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
	await mkdir(dirname(worktreePath), { recursive: true });
	// Clear stale registrations a crashed/removed worktree can leave behind, or
	// `git worktree add` refuses with "missing but already registered".
	await runGit(repoPath, ["worktree", "prune"]);

	if (await branchExists(repoPath, branch)) {
		await addWorktreeOnExistingBranch(repoPath, worktreePath, branch);
		return;
	}

	// No local branch yet. A clone carries the board branch on its remote, so
	// fetch + track it instead of orphaning a fresh (empty) branch over the data.
	const remote = await getDefaultRemote(repoPath);
	if (remote) {
		// This is the cold-clone boot path. Bound the fetch with the network timeout so a
		// stalled connection / credential prompt / unreachable remote can't hang startup
		// indefinitely (the hot-start path early-returns above via `isGitWorktree`, so it
		// never reaches here). On expiry the git child is SIGKILL'd and the fetch reports
		// failure, classified below.
		const fetchResult = await runGit(repoPath, ["fetch", remote, branch], {
			timeoutMs: BOARD_NETWORK_GIT_TIMEOUT_MS,
		});
		if (await remoteBranchExists(repoPath, remote, branch)) {
			const addResult = await runGit(repoPath, [
				"worktree",
				"add",
				"--track",
				"-b",
				branch,
				worktreePath,
				`${remote}/${branch}`,
			]);
			if (!addResult.ok) {
				throw new Error(addResult.error ?? addResult.output);
			}
			return;
		}
		// The remote ref is absent. Two very different causes, and conflating them is
		// dangerous: a remote that genuinely lacks the branch (brand-new project on the
		// other side) is the legitimate degradation — orphan a fresh empty branch. But a
		// fetch that failed for a network reason (offline / unreachable / timed out) leaves
		// the real board data sitting on the remote, so orphaning an empty branch over it
		// would mask that data behind a divergent local board. Surface a clear error in that
		// case instead — setup reports failure (boot continues; the next load retries).
		if (!fetchResult.ok && !isMissingRemoteRefError(fetchResult.output)) {
			throw new Error(
				`Could not fetch the board branch '${branch}' from '${remote}' (the remote may be unreachable or slow). ` +
					`Refusing to initialize an empty board over data that may live on the remote. ${
						fetchResult.error ?? fetchResult.output
					}`,
			);
		}
		log.warn("board-ref present but remote has no board branch; initializing an empty board branch", {
			repoPath,
			remote,
			branch,
		});
	}

	await createOrphanBranchViaPlumbing(repoPath, branch);
	await addWorktreeOnExistingBranch(repoPath, worktreePath, branch);
}

async function addWorktreeOnExistingBranch(repoPath: string, worktreePath: string, branch: string): Promise<void> {
	const addResult = await runGit(repoPath, ["worktree", "add", worktreePath, branch]);
	if (!addResult.ok) {
		throw new Error(addResult.error ?? addResult.output);
	}
}

/**
 * Ensure the board worktree exists and is checked out on the configured board
 * branch, creating the orphan branch on first run. Idempotent and serialized by a
 * git-common-dir lock (mirroring task-worktree setup).
 *
 * Gated on the board-ref pointer: when decoupling is **not** active the call is a
 * cheap no-op (committed data stays in the main checkout). Activating decoupling —
 * writing the pointer and seeding the worktree from existing data — is a later
 * migration phase (P2); this phase ships the lifecycle machinery the migration and
 * every subsequent load rely on.
 */
export async function ensureBoardWorktree(repoPath: string): Promise<EnsureBoardWorktreeResult> {
	const boardRef = await readBoardRef(repoPath);
	if (!boardRef) {
		return { ok: true, path: null, branch: null, created: false };
	}
	const branch = boardRef.branch.trim() || DEFAULT_BOARD_BRANCH;
	return await setupBoardWorktree(repoPath, branch);
}

/**
 * Ensure the board worktree exists on `branch`, creating the orphan branch (or, in a
 * clone, fetching + tracking the remote one) on first run. The board-ref-gated
 * {@link ensureBoardWorktree} wrapper is the load-path entry point; the P2 decouple
 * migration calls this directly because it must seed the worktree *before* writing
 * the pointer that activates decoupling. Idempotent and serialized by a
 * git-common-dir lock (mirroring task-worktree setup).
 */
export async function setupBoardWorktree(repoPath: string, branch: string): Promise<EnsureBoardWorktreeResult> {
	const worktreePath = getBoardWorktreePath(repoPath);

	if (await isGitWorktree(worktreePath)) {
		return { ok: true, path: worktreePath, branch, created: false };
	}

	return await lockedFileSystem.withLock(await getBoardWorktreeSetupLock(repoPath), async () => {
		if (await isGitWorktree(worktreePath)) {
			return { ok: true, path: worktreePath, branch, created: false };
		}
		try {
			await createBoardWorktree(repoPath, worktreePath, branch);
			return { ok: true, path: worktreePath, branch, created: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error("failed to ensure board worktree", { repoPath, branch, error });
			return { ok: false, path: null, branch, created: false, error: message };
		}
	});
}

/**
 * Has the board branch had its initial data committed yet? Distinguishes a freshly
 * created orphan branch (only the empty-tree commit) from one already seeded with
 * board data, so the P2 migration never re-seeds — and never clobbers — a worktree
 * that already holds data after a crash + retry.
 */
export async function boardWorktreeHasCommittedData(repoPath: string): Promise<boolean> {
	const result = await runGit(getBoardWorktreePath(repoPath), ["ls-tree", "-r", "--name-only", "HEAD"]);
	return result.ok && result.stdout.trim().length > 0;
}

/**
 * Stage everything in the board worktree (the `.kanban/.gitignore` denylist filters
 * runtime/secret files) and commit with the dedicated board identity. The worktree
 * is runtime-exclusive, so a plain `add -A` is safe (no human edits to preserve).
 * Returns false when there was nothing to commit.
 */
export async function commitBoardWorktree(repoPath: string, message: string): Promise<boolean> {
	const worktreePath = getBoardWorktreePath(repoPath);
	const env = buildBoardCommitEnv();
	await getGitStdout(["add", "-A"], worktreePath, { env });
	const staged = await runGit(worktreePath, ["diff", "--cached", "--quiet"], { env });
	if (staged.ok) {
		// Exit 0 from `diff --cached --quiet` means nothing is staged.
		return false;
	}
	const commit = await runGit(worktreePath, ["commit", "-m", message], { env });
	return commit.ok;
}

/** Is `.kanban/board-ref` tracked on the code branch? The authoritative "fully decoupled" signal. */
export async function isBoardRefTrackedOnCodeBranch(repoPath: string): Promise<boolean> {
	const result = await runGit(repoPath, ["ls-files", "--", BOARD_REF_REPO_RELATIVE_PATH]);
	return result.ok && result.stdout.trim().length > 0;
}

/**
 * Does the code branch have at least one commit (a born HEAD)? Decoupling needs one:
 * the `board-ref` pointer can only be *tracked* (and so survive a clone) on top of a
 * commit, and an unborn repo has no committed `.kanban` data to move. Until then the
 * migration is a no-op and committed data stays in the main checkout.
 */
export async function codeBranchHasCommit(repoPath: string): Promise<boolean> {
	const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	return result.ok && result.stdout.trim().length > 0;
}

/**
 * Commit the code-branch side of the decouple: drop `.kanban` from tracking (keeping
 * the working tree for revert-based rollback) while keeping `.kanban/board-ref` and
 * the flipped root `.gitignore`. The commit tree is built in a throwaway index off
 * HEAD so unrelated user-staged changes are never swept into this machine-authored
 * commit; the real index is then synced for the affected paths so the code-branch
 * working tree is clean against the new HEAD. Returns false when nothing changed.
 *
 * Callers must have already written `.kanban/board-ref` and appended the
 * `/.kanban/*` + `!/.kanban/board-ref` rule to the root `.gitignore`.
 */
export async function commitCodeBranchDecoupling(repoPath: string): Promise<boolean> {
	const env = buildBoardCommitEnv();
	const symRef = await runGit(repoPath, ["symbolic-ref", "--quiet", "HEAD"]);
	const targetRef = symRef.ok && symRef.stdout ? symRef.stdout : "HEAD";

	const tempDir = await mkdtemp(join(tmpdir(), "kanban-decouple-"));
	try {
		const tempEnv: NodeJS.ProcessEnv = { ...env, GIT_INDEX_FILE: join(tempDir, "index") };
		await getGitStdout(["read-tree", "HEAD"], repoPath, { env: tempEnv });
		await stageDecoupleIndexChanges(repoPath, tempEnv);
		const tree = await getGitStdout(["write-tree"], repoPath, { env: tempEnv });
		const headTree = await getGitStdout(["rev-parse", "HEAD^{tree}"], repoPath, { env: tempEnv });
		if (tree === headTree) {
			return false;
		}
		const commit = await getGitStdout(["commit-tree", tree, "-p", "HEAD", "-m", DECOUPLE_COMMIT_MESSAGE], repoPath, {
			env: tempEnv,
		});
		await getGitStdout(["update-ref", targetRef, commit], repoPath, { env });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}

	// Sync the real index for the affected paths so `git status` is clean vs the new
	// HEAD (user-staged changes to other paths are left untouched).
	await stageDecoupleIndexChanges(repoPath, env);
	return true;
}

/**
 * Stage the decouple's index delta against whichever index `env` selects: remove all
 * tracked `.kanban` entries (no-op-safe via `--ignore-unmatch`) then re-add the
 * pointer + flipped root `.gitignore` (the `!/.kanban/board-ref` negation re-includes
 * the pointer despite the `/.kanban/*` rule).
 */
async function stageDecoupleIndexChanges(repoPath: string, env: NodeJS.ProcessEnv): Promise<void> {
	await runGit(repoPath, ["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", KANBAN_RUNTIME_HOME_DIR_NAME], {
		env,
	});
	await runGit(repoPath, ["add", "--", ROOT_GITIGNORE_FILENAME, BOARD_REF_REPO_RELATIVE_PATH], { env });
}

/**
 * Commit a changed `.kanban/board-ref` onto the code branch so the (renamed) board
 * branch name travels with a clone. Like {@link commitCodeBranchDecoupling} the commit
 * is built in a throwaway index off HEAD so unrelated user-staged changes are never
 * swept in, then the real index is synced for the pointer. A no-op (returns false)
 * when the pointer is not yet tracked (decoupling not committed) or already current.
 */
export async function commitBoardRefUpdate(repoPath: string): Promise<boolean> {
	if (!(await isBoardRefTrackedOnCodeBranch(repoPath))) {
		return false;
	}
	const env = buildBoardCommitEnv();
	const symRef = await runGit(repoPath, ["symbolic-ref", "--quiet", "HEAD"]);
	const targetRef = symRef.ok && symRef.stdout ? symRef.stdout : "HEAD";

	const tempDir = await mkdtemp(join(tmpdir(), "kanban-board-ref-"));
	try {
		const tempEnv: NodeJS.ProcessEnv = { ...env, GIT_INDEX_FILE: join(tempDir, "index") };
		await getGitStdout(["read-tree", "HEAD"], repoPath, { env: tempEnv });
		await runGit(repoPath, ["add", "--", BOARD_REF_REPO_RELATIVE_PATH], { env: tempEnv });
		const tree = await getGitStdout(["write-tree"], repoPath, { env: tempEnv });
		const headTree = await getGitStdout(["rev-parse", "HEAD^{tree}"], repoPath, { env: tempEnv });
		if (tree === headTree) {
			return false;
		}
		const commit = await getGitStdout(
			["commit-tree", tree, "-p", "HEAD", "-m", BOARD_REF_UPDATE_COMMIT_MESSAGE],
			repoPath,
			{ env: tempEnv },
		);
		await getGitStdout(["update-ref", targetRef, commit], repoPath, { env });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
	await runGit(repoPath, ["add", "--", BOARD_REF_REPO_RELATIVE_PATH], { env });
	return true;
}

export interface BoardWorktreeProbe {
	exists: boolean;
	path: string;
	branch: string | null;
	headCommit: string | null;
	isDetached: boolean;
}

/** Inspect the board worktree's on-disk state (existence, branch, HEAD) for diagnostics. */
export async function probeBoardWorktree(repoPath: string): Promise<BoardWorktreeProbe> {
	const path = getBoardWorktreePath(repoPath);
	if (!(await isGitWorktree(path))) {
		return { exists: false, path, branch: null, headCommit: null, isDetached: false };
	}
	const headResult = await runGit(path, ["rev-parse", "--verify", "HEAD"]);
	const headCommit = headResult.ok ? headResult.stdout : null;
	const branchResult = await runGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = branchResult.ok ? branchResult.stdout : null;
	return {
		exists: true,
		path,
		branch,
		headCommit,
		isDetached: headCommit !== null && branch === null,
	};
}

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { DEFAULT_BOARD_BRANCH, readBoardRef } from "../state/board-ref";
import { getGitStdout, runGit } from "./git-utils";
import {
	BOARD_WORKTREE_SENTINEL,
	getWorkspaceFolderLabelForWorktreePath,
	KANBAN_RUNTIME_HOME_DIR_NAME,
	KANBAN_TASK_WORKTREES_DIR_NAME,
} from "./task-worktree-path";

const log = createLogger("board-worktree");

const BOARD_WORKTREE_SETUP_LOCKFILE_NAME = "kanban-board-worktree-setup.lock";

// Dedicated identity for the parentless initial commit of an orphan board branch,
// mirroring the checkpoint identity in turn-checkpoints.ts.
const BOARD_AUTHOR_NAME = "kanban-board";
const BOARD_AUTHOR_EMAIL = "kanban-board@local";

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

	if (!(await branchExists(repoPath, branch))) {
		await createOrphanBranchViaPlumbing(repoPath, branch);
	}

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

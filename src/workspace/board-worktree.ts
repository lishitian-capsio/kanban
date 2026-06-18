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
	return remotes.includes("origin") ? "origin" : remotes[0];
}

async function remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean> {
	const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
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

	if (await branchExists(repoPath, branch)) {
		await addWorktreeOnExistingBranch(repoPath, worktreePath, branch);
		return;
	}

	// No local branch yet. A clone carries the board branch on its remote, so
	// fetch + track it instead of orphaning a fresh (empty) branch over the data.
	const remote = await getDefaultRemote(repoPath);
	if (remote) {
		// Best-effort: a remote that lacks the branch (brand-new project on the
		// other side) just leaves the remote ref absent, handled below.
		await runGit(repoPath, ["fetch", remote, branch]);
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

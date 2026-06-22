import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../logging/logger";
import { runGit } from "./git-utils";

const log = createLogger("initialize-repo");

interface InitializeRepoResult {
	ok: boolean;
	error: string | null;
}

/**
 * Hard cap (ms) on the `git add -A` + `git commit` that seeds a freshly initialized
 * repo. Adding a project is an interactive request the UI blocks on; without a bound,
 * a directory dominated by huge un-ignored content (datasets, media, a stray
 * `node_modules` a default `.gitignore` happens not to cover) makes `git add` hash and
 * duplicate gigabytes into `.git/objects`, wedging the request — the user sees an
 * infinite spinner and the runtime can exhaust memory/disk. On expiry the git child is
 * killed and the call fails with an actionable error instead of hanging forever.
 */
const INITIAL_COMMIT_GIT_TIMEOUT_MS = 120_000;

/**
 * Default ignore rules written into a freshly initialized repo that has no
 * `.gitignore` of its own. Scoped to dependency caches and build output — content
 * that is regenerable, never belongs in history, and (critically) is what makes a
 * project directory "large", so staging it is what makes the initial `git add -A`
 * hang. Deliberately conservative: only universally-generated directories, so we
 * never silently exclude a user's source.
 */
const DEFAULT_GITIGNORE_CONTENT = `# Created by Kanban when initializing git for this project.
# Dependency directories
node_modules/
bower_components/
.pnp/
.yarn/
vendor/bundle/

# Build output
dist/
build/
out/
.next/
.nuxt/
.svelte-kit/
.turbo/
target/

# Python environments / caches
.venv/
venv/
__pycache__/

# Caches, coverage, logs
.cache/
coverage/
*.log

# OS / editor cruft
.DS_Store
Thumbs.db
`;

/**
 * Write {@link DEFAULT_GITIGNORE_CONTENT} into `projectPath/.gitignore` only when the
 * project has no `.gitignore` yet. Returns `true` when a file was created, `false`
 * when one already existed (its content is left untouched — we never overwrite the
 * user's rules). Pure filesystem work; no git invocation.
 */
export async function ensureDefaultGitignore(projectPath: string): Promise<boolean> {
	const gitignorePath = join(projectPath, ".gitignore");
	try {
		await readFile(gitignorePath, "utf8");
		return false;
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			throw error;
		}
	}
	await writeFile(gitignorePath, DEFAULT_GITIGNORE_CONTENT, "utf8");
	return true;
}

function isFileNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

export async function initializeGitRepository(projectPath: string): Promise<InitializeRepoResult> {
	const result = await runGit(projectPath, ["init"], { timeoutMs: INITIAL_COMMIT_GIT_TIMEOUT_MS });
	if (!result.ok) {
		return {
			ok: false,
			error: result.error ?? "Failed to initialize git repository.",
		};
	}

	return ensureInitialCommit(projectPath);
}

export async function ensureInitialCommit(projectPath: string): Promise<InitializeRepoResult> {
	const headCheck = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"]);
	if (headCheck.ok) {
		return { ok: true, error: null };
	}

	// Seed a sensible .gitignore first so the staging below never hashes + duplicates
	// dependency/build directories into the repo — the root cause of "adding a large
	// non-git folder hangs and crashes". Only created when the project has none.
	try {
		if (await ensureDefaultGitignore(projectPath)) {
			log.info("wrote a default .gitignore for a newly initialized project", { projectPath });
		}
	} catch (error) {
		// A failure here is non-fatal: fall through to staging (bounded by the timeout
		// below) rather than blocking the project from being added.
		log.warn("could not write a default .gitignore; staging the project as-is", { projectPath, error });
	}

	const addResult = await runGit(projectPath, ["add", "-A"], { timeoutMs: INITIAL_COMMIT_GIT_TIMEOUT_MS });
	if (!addResult.ok) {
		return {
			ok: false,
			error: stagingTimeoutHint(addResult.error ?? "Failed to stage files for initial commit."),
		};
	}

	const commitResult = await runGit(projectPath, ["commit", "--allow-empty", "-m", "Initial commit through Kanban"], {
		timeoutMs: INITIAL_COMMIT_GIT_TIMEOUT_MS,
	});

	if (!commitResult.ok) {
		return {
			ok: false,
			error: commitResult.error ?? "Failed to create initial commit.",
		};
	}

	return { ok: true, error: null };
}

/**
 * Augment a staging failure with guidance for the most likely cause at this scale —
 * the directory holds so much un-ignored content that `git add` exceeded its time
 * budget. Pointing the user at a `.gitignore` is the actionable fix.
 */
function stagingTimeoutHint(error: string): string {
	return `${error} If this folder contains very large or generated content (datasets, media, build output), add a .gitignore for it and try again.`;
}

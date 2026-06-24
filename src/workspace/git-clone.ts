import { access, mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { buildSubprocessProxyEnv } from "../config/proxy-fetch.js";
import { createGitProcessEnv } from "../core/git-process-env.js";
import { runGit } from "./git-utils.js";
import { isPathWithinRoot } from "./path-sandbox.js";

/**
 * Wall-clock cap for `git clone`. A clone is a network op, so an unreachable or stalled
 * remote would otherwise hang the request indefinitely. Generous enough not to kill a
 * legitimately large clone over a slow link, but finite so a dead remote always fails.
 */
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;

export interface GitCloneResult {
	ok: boolean;
	clonedPath: string;
	error?: string;
}

/**
 * Derive a repository name from a Git URL.
 *
 * Handles HTTPS URLs (e.g. `https://github.com/user/repo.git`),
 * SSH URLs (e.g. `git@github.com:user/repo.git`), and bare names.
 * Strips a trailing `.git` suffix if present.
 */
export function deriveRepoNameFromUrl(gitUrl: string): string | null {
	const trimmed = gitUrl.trim().replace(/\/+$/, "");
	if (!trimmed) {
		return null;
	}

	// Handle SSH-style URLs: git@host:user/repo.git
	const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
	const pathPart = sshMatch?.[1] ?? trimmed;

	// Take the last path segment.
	const lastSegment = basename(pathPart);
	if (!lastSegment) {
		return null;
	}

	// Strip trailing .git
	const name = lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
	return name || null;
}

/**
 * Validate that a resolved destination path is within the server CWD sandbox.
 * Returns the resolved absolute path if valid, or throws an error.
 */
export function validateCloneDestination(destination: string, serverCwd: string): string {
	const resolved = resolve(destination);
	if (!isPathWithinRoot(serverCwd, resolved)) {
		throw new Error(
			`Clone destination is outside the server working directory. Destination "${resolved}" must be within "${serverCwd}".`,
		);
	}
	return resolved;
}

/**
 * Clone a Git repository to a destination directory within the server CWD.
 *
 * @param gitUrl - The Git repository URL to clone.
 * @param serverCwd - The server's current working directory (sandbox root).
 * @param destinationPath - Optional custom destination path. If omitted, the
 *   clone is placed at `<serverCwd>/<repo-name>`.
 * @param allowedRootPath - Optional root boundary for destination validation.
 *   Defaults to `serverCwd`.
 */
export async function cloneGitRepository(
	gitUrl: string,
	serverCwd: string,
	destinationPath?: string,
	allowedRootPath: string = serverCwd,
): Promise<GitCloneResult> {
	const repoName = deriveRepoNameFromUrl(gitUrl);
	if (!repoName && !destinationPath) {
		return {
			ok: false,
			clonedPath: "",
			error: "Could not derive repository name from URL and no destination path was provided.",
		};
	}

	// At this point either repoName or destinationPath is truthy (guarded above).
	const rawDestination = destinationPath ?? resolve(serverCwd, repoName as string);

	let clonePath: string;
	try {
		clonePath = validateCloneDestination(rawDestination, allowedRootPath);
	} catch (error) {
		return {
			ok: false,
			clonedPath: rawDestination,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// If the destination already exists and is a directory, append the repo name
	// so the behavior matches native `git clone <url> <existing-dir>` — the repo
	// is cloned *into* the directory rather than rejected outright.
	try {
		await access(clonePath);
		const destStat = await stat(clonePath);
		if (destStat.isDirectory() && repoName) {
			const nestedPath = resolve(clonePath, repoName);
			try {
				clonePath = validateCloneDestination(nestedPath, allowedRootPath);
			} catch (error) {
				return {
					ok: false,
					clonedPath: nestedPath,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			// Verify the nested destination doesn't already exist.
			try {
				await access(clonePath);
				return {
					ok: false,
					clonedPath: clonePath,
					error: `Destination already exists: "${clonePath}".`,
				};
			} catch {
				// Good — the nested path does not exist yet.
			}
		} else {
			return {
				ok: false,
				clonedPath: clonePath,
				error: `Destination already exists: "${clonePath}".`,
			};
		}
	} catch {
		// Expected: destination does not exist yet.
	}

	// Ensure the parent directory exists.
	const parentDir = dirname(clonePath);
	try {
		await mkdir(parentDir, { recursive: true });
	} catch (error) {
		return {
			ok: false,
			clonedPath: clonePath,
			error: `Failed to create parent directory "${parentDir}": ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// Run `git clone <url> <destination>`.
	// The cwd for the git process should be the parent directory of the destination.
	//
	// env: start from the sanitized git env, then layer in the configured outbound proxy
	// (so a proxy set in Kanban settings reaches the clone — the runtime strips proxy URLs
	// from its own process.env at boot, so without this the clone would go direct) and
	// disable interactive credential prompts. GIT_TERMINAL_PROMPT=0 makes a private repo
	// that needs auth fail fast instead of blocking on an unanswerable username prompt.
	const cloneEnv = createGitProcessEnv({
		...buildSubprocessProxyEnv(),
		GIT_TERMINAL_PROMPT: "0",
	});
	const result = await runGit(parentDir, ["clone", "--", gitUrl, clonePath], {
		env: cloneEnv,
		timeoutMs: GIT_CLONE_TIMEOUT_MS,
	});
	if (!result.ok) {
		return {
			ok: false,
			clonedPath: clonePath,
			error: describeCloneFailure(result, gitUrl),
		};
	}

	return {
		ok: true,
		clonedPath: clonePath,
	};
}

interface CloneFailureInfo {
	stderr: string;
	output: string;
	error: string | null;
	timedOut: boolean;
}

/**
 * Map a failed `git clone` into a clear, user-facing message. Authentication / credential
 * failures (common for private repos under a non-interactive runtime, where git can't
 * prompt for a username) and timeouts (unreachable / stalled remote) get actionable
 * guidance instead of the raw, cryptic git error.
 */
function describeCloneFailure(result: CloneFailureInfo, gitUrl: string): string {
	if (result.timedOut) {
		return `Git clone timed out — the remote "${gitUrl}" may be unreachable. Check the URL, your network, and any proxy settings, then try again.`;
	}

	const haystack = `${result.stderr}\n${result.output}\n${result.error ?? ""}`.toLowerCase();
	const looksLikeAuthFailure =
		haystack.includes("could not read username") ||
		haystack.includes("could not read password") ||
		haystack.includes("authentication failed") ||
		haystack.includes("terminal prompts disabled") ||
		haystack.includes("permission denied");

	if (looksLikeAuthFailure) {
		return `Git clone failed — "${gitUrl}" requires credentials, or they were rejected. Configure access for this Git host (e.g. \`gh auth setup-git\`, a personal access token in the URL, or an SSH key) and try again.`;
	}

	return result.error ?? `Git clone failed: ${result.stderr || result.output}`;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface GitCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	output: string;
	error: string | null;
	exitCode: number;
	/**
	 * True when the invocation was killed by the `timeoutMs` wall-clock cap rather than
	 * exiting on its own. Lets callers distinguish "remote unreachable / stalled" from an
	 * ordinary non-zero git exit and surface a clearer message.
	 */
	timedOut: boolean;
}

export interface RunGitOptions {
	trimStdout?: boolean;
	env?: NodeJS.ProcessEnv;
	/**
	 * Hard wall-clock cap (ms) for the git invocation. On expiry the child is killed and
	 * the call resolves as a failure (`ok: false`) instead of hanging indefinitely. Used to
	 * bound network git ops (push/fetch/merge) so a stalled connection or a credential
	 * prompt can never wedge a serialized work queue. Omit for unbounded local ops.
	 */
	timeoutMs?: number;
}

function normalizeProcessExitCode(code: unknown): number {
	if (typeof code === "number" && Number.isFinite(code)) {
		return code;
	}
	if (typeof code === "string") {
		const parsed = Number(code);
		if (Number.isInteger(parsed)) {
			return parsed;
		}
	}
	return -1;
}

export async function runGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<GitCommandResult> {
	try {
		const fullArgs = ["-c", "core.quotepath=false", ...args];
		const { stdout, stderr } = await execFileAsync("git", fullArgs, {
			cwd,
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER_BYTES,
			env: options.env || createGitProcessEnv(),
			...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: "SIGKILL" } : {}),
		});
		const normalizedStdout = String(stdout ?? "").trim();
		const normalizedStderr = String(stderr ?? "").trim();
		return {
			ok: true,
			stdout: options.trimStdout === false ? stdout : normalizedStdout,
			stderr: normalizedStderr,
			output: [normalizedStdout, normalizedStderr].filter(Boolean).join("\n"),
			error: null,
			exitCode: 0,
			timedOut: false,
		};
	} catch (error) {
		const candidate = error as {
			code?: string | number | null;
			stdout?: unknown;
			stderr?: unknown;
			message?: unknown;
			killed?: boolean;
			signal?: string;
		};
		const rawStdout = String(candidate.stdout ?? "");
		const stdout = options.trimStdout === false ? rawStdout : rawStdout.trim();
		const stderr = String(candidate.stderr ?? "").trim();
		const message = String(candidate.message ?? "").trim();
		const command = `git ${args.join(" ")} failed`;
		const errorMessage = `Failed to run Git Command: \n Command: \n ${command} \n ${stderr || message}`;
		const exitCode = normalizeProcessExitCode(candidate.code);

		return {
			ok: false,
			stdout,
			stderr,
			output: [stdout, stderr].filter(Boolean).join("\n"),
			error: errorMessage,
			exitCode,
			// `execFile` sets `killed` when it tears the child down for exceeding `timeout`.
			timedOut: candidate.killed === true,
		};
	}
}

export async function getGitStdout(args: string[], cwd: string, options: RunGitOptions = {}): Promise<string> {
	const result = await runGit(cwd, args, options);
	if (!result.ok) {
		throw new Error(result.error || result.stdout);
	}

	return result.stdout;
}

export interface GitHeadInfo {
	branch: string | null;
	headCommit: string | null;
	isDetached: boolean;
}

/**
 * Read the current HEAD commit, branch name, and detached state for a
 * repository (or worktree) at `cwd`.
 */
export async function readGitHeadInfo(cwd: string): Promise<GitHeadInfo> {
	const headResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	const headCommit = headResult.ok ? headResult.stdout : null;
	const branchResult = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = branchResult.ok ? branchResult.stdout : null;
	return {
		branch,
		headCommit,
		isDetached: headCommit !== null && branch === null,
	};
}

export interface GitUserIdentity {
	name: string;
	email: string;
}

/**
 * Read the effective git identity (`user.name` / `user.email`) resolved from the
 * repository at `cwd` — repo-local config first, then the user's global config, the
 * same precedence `git commit` uses for authorship. Returns `null` only when git
 * resolves neither field (no identity configured at any scope), so a partially
 * configured repo still yields the field it has.
 */
export async function readGitUserIdentity(cwd: string): Promise<GitUserIdentity | null> {
	const [nameResult, emailResult] = await Promise.all([
		runGit(cwd, ["config", "user.name"]),
		runGit(cwd, ["config", "user.email"]),
	]);
	const name = nameResult.ok ? nameResult.stdout.trim() : "";
	const email = emailResult.ok ? emailResult.stdout.trim() : "";
	if (!name && !email) {
		return null;
	}
	return { name, email };
}

/**
 * Write the **repo-local** git identity (`user.name` / `user.email`) at `cwd` — this
 * is the real `.git/config`, not a Kanban-only setting, so it governs the author of
 * every commit the repo (and its task worktrees, which share the same config) makes.
 * Never writes `--global`. A non-empty field is set; an empty field is cleared with
 * `--unset` (tolerating it already being absent, git exit 5), keeping the on-disk
 * config in sync with what the caller passed. Rejecting both-empty matches
 * {@link readGitUserIdentity}'s null semantics. Throws with the git error on failure
 * (e.g. when `cwd` is not a git repository).
 */
export async function writeGitUserIdentity(cwd: string, identity: GitUserIdentity): Promise<void> {
	const name = identity.name.trim();
	const email = identity.email.trim();
	if (!name && !email) {
		throw new Error("Provide a git user name or email — at least one is required.");
	}
	await applyGitConfigField(cwd, "user.name", name);
	await applyGitConfigField(cwd, "user.email", email);
}

async function applyGitConfigField(cwd: string, key: string, value: string): Promise<void> {
	if (value) {
		const result = await runGit(cwd, ["config", key, value]);
		if (!result.ok) {
			throw new Error(result.error || `Failed to set git ${key}.`);
		}
		return;
	}
	// Empty value clears the repo-local setting; exit 5 means it was never set, which
	// is the desired end state, so it is not an error.
	const result = await runGit(cwd, ["config", "--unset", key]);
	if (!result.ok && result.exitCode !== 5) {
		throw new Error(result.error || `Failed to clear git ${key}.`);
	}
}

/**
 * Basic shape check for a git remote URL — not a full parser, just enough to reject
 * obvious garbage (empty, internal whitespace) before handing the value to git. Accepts
 * the forms git itself supports: a `scheme://…` URL (https/http/ssh/git/file/…), the
 * scp-like `user@host:path` SSH syntax, and a local filesystem path (`/`, `.`, `~`).
 * Kept in sync with the `runtimeSetGitRemoteRequestSchema` refinement in api-contract.ts.
 */
export function isLikelyGitRemoteUrl(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed === "") {
		return false;
	}
	return /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+|[^@\s]+@[^:\s]+:\S+|[./~]\S*)$/.test(trimmed);
}

/**
 * Read the `origin` remote URL for the repository at `cwd` via `git remote get-url
 * origin`. Returns `null` when no `origin` remote is configured (git exits non-zero) —
 * the common case for a repo Kanban `git init`-ed locally — rather than throwing, so the
 * caller can present an empty "not configured yet" state.
 */
export async function readGitRemoteUrl(cwd: string): Promise<string | null> {
	const result = await runGit(cwd, ["remote", "get-url", "origin"]);
	if (!result.ok) {
		return null;
	}
	const url = result.stdout.trim();
	return url === "" ? null : url;
}

/**
 * Set the `origin` remote URL for the repository at `cwd`. Adds the remote when it does
 * not exist yet (`git remote add origin <url>`) and rewrites it otherwise (`git remote
 * set-url origin <url>`), matching the requested behavior. Validates the URL shape first
 * with {@link isLikelyGitRemoteUrl} and never touches authentication — credentials stay
 * with the system git credential helper / SSH agent. Throws with the git error on
 * failure (e.g. when `cwd` is not a git repository).
 */
export async function writeGitRemoteUrl(cwd: string, url: string): Promise<void> {
	const trimmed = url.trim();
	if (!isLikelyGitRemoteUrl(trimmed)) {
		throw new Error("Enter a valid git remote URL.");
	}
	const existing = await readGitRemoteUrl(cwd);
	const args = existing === null ? ["remote", "add", "origin", trimmed] : ["remote", "set-url", "origin", trimmed];
	const result = await runGit(cwd, args);
	if (!result.ok) {
		throw new Error(result.error || "Failed to set the git remote URL.");
	}
}

export function getGitCommandErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === "string" && stderr.trim()) {
			return stderr.trim();
		}
	}
	return error instanceof Error ? error.message : String(error);
}

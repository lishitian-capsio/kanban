/**
 * Pure logic for the `kanban release` command (see vault decision d10e2 — Kanban's release
 * feature is a *ceremony orchestrator*; it never builds/packs, that is delegated to the
 * project's own CI via the tag-push → `build-release.yml` path).
 *
 * Everything here is side-effect-free: version arithmetic, precheck evaluation, git-output
 * parsing, and command construction. The I/O (git spawns, package.json writes, `npm install`,
 * the best-effort Actions-link lookup) lives in `release.ts`, so this core stays unit-testable
 * without touching the filesystem, git, or the network.
 */

import { CliError } from "./cli-envelope";

/** The three semantic bump levels this command supports. Prerelease/nightly are out of scope. */
export type ReleaseBumpLevel = "patch" | "minor" | "major";

export interface Semver {
	major: number;
	minor: number;
	patch: number;
}

/** Strict `x.y.z` — no prerelease/build metadata, no partial versions. Optional leading `v`. */
const STRICT_SEMVER_REGEX = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a strict `x.y.z` version (a leading `v` is tolerated). Rejects prerelease suffixes,
 * build metadata, and partial versions, because a release tag must be a clean `vX.Y.Z` so the
 * `kanban-<version>.tgz` produced by `build-release.yml` matches what `kanban update` expects.
 */
export function parseReleaseVersion(value: string): Semver {
	const match = STRICT_SEMVER_REGEX.exec(value.trim());
	if (!match) {
		throw new CliError(
			"invalid_argument",
			`Invalid version "${value}". Expected a strict semantic version like 1.2.3 (no prerelease suffix).`,
		);
	}
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version: Semver): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

/** Compare two versions: -1 when `a < b`, 0 when equal, 1 when `a > b`. */
export function compareVersions(a: Semver, b: Semver): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) {
			return a[key] < b[key] ? -1 : 1;
		}
	}
	return 0;
}

function bumpVersion(current: Semver, level: ReleaseBumpLevel): Semver {
	switch (level) {
		case "major":
			return { major: current.major + 1, minor: 0, patch: 0 };
		case "minor":
			return { major: current.major, minor: current.minor + 1, patch: 0 };
		case "patch":
			return { major: current.major, minor: current.minor, patch: current.patch + 1 };
	}
}

export interface BumpSelectionInput {
	patch?: boolean;
	minor?: boolean;
	major?: boolean;
	/** An explicit `x.y.z` target (the `[version]` positional) that overrides the bump levels. */
	explicit?: string;
}

export interface ResolvedReleaseVersion {
	previousVersion: string;
	nextVersion: string;
	bump: ReleaseBumpLevel | "explicit";
}

/**
 * Resolve the next version from the current `package.json` version and the mutually-exclusive
 * bump selectors. An explicit target wins (must be a valid strict semver strictly greater than
 * the current one); otherwise exactly one of `--patch`/`--minor`/`--major` is honored,
 * defaulting to `patch`. Throws {@link CliError} `invalid_argument` on any conflicting combination.
 */
export function resolveReleaseVersion(currentVersion: string, input: BumpSelectionInput): ResolvedReleaseVersion {
	const current = parseReleaseVersion(currentVersion);
	const levels = (["patch", "minor", "major"] as const).filter((level) => input[level] === true);
	const explicit = input.explicit?.trim();

	if (explicit) {
		if (levels.length > 0) {
			throw new CliError(
				"invalid_argument",
				"Pass either an explicit version or a bump level (--patch/--minor/--major), not both.",
			);
		}
		const next = parseReleaseVersion(explicit);
		if (compareVersions(next, current) <= 0) {
			throw new CliError(
				"invalid_argument",
				`The requested version ${formatVersion(next)} must be greater than the current version ${formatVersion(current)}.`,
			);
		}
		return { previousVersion: formatVersion(current), nextVersion: formatVersion(next), bump: "explicit" };
	}

	if (levels.length > 1) {
		throw new CliError("invalid_argument", "Choose only one of --patch, --minor, or --major.");
	}
	const level: ReleaseBumpLevel = levels[0] ?? "patch";
	return {
		previousVersion: formatVersion(current),
		nextVersion: formatVersion(bumpVersion(current, level)),
		bump: level,
	};
}

export interface ReleasePrecheckInput {
	/** The branch HEAD points at, or `null` on a detached HEAD. */
	currentBranch: string | null;
	/** The branch releases must run from (typically `main`). */
	defaultBranch: string;
	/** True when `git status --porcelain` is empty. */
	workingTreeClean: boolean;
	/** Commits in `origin/<default>` not in local HEAD. */
	behind: number;
	/** Commits in local HEAD not in `origin/<default>`. */
	ahead: number;
}

export interface ReleasePrecheckResult {
	ok: boolean;
	failures: string[];
}

/**
 * Evaluate the release prechecks (decision d10e2 step 1): must be on the default branch, with
 * a clean working tree, fully in sync with `origin/<default>`. Returns *all* failures so the
 * operator sees everything wrong at once rather than fixing them one round-trip at a time.
 */
export function evaluateReleasePrechecks(input: ReleasePrecheckInput): ReleasePrecheckResult {
	const failures: string[] = [];
	if (input.currentBranch !== input.defaultBranch) {
		const where = input.currentBranch ?? "a detached HEAD";
		failures.push(`Releases must run from "${input.defaultBranch}", but you are on ${where}. Switch branches first.`);
	}
	if (!input.workingTreeClean) {
		failures.push("Working tree has uncommitted changes. Commit or stash them first.");
	}
	if (input.behind > 0) {
		failures.push(
			`Local ${input.defaultBranch} is behind origin/${input.defaultBranch} by ${input.behind} commit(s). Pull first.`,
		);
	}
	if (input.ahead > 0) {
		failures.push(
			`Local ${input.defaultBranch} is ahead of origin/${input.defaultBranch} by ${input.ahead} commit(s). Push first.`,
		);
	}
	return { ok: failures.length === 0, failures };
}

/**
 * Parse `git rev-list --left-right --count origin/<default>...HEAD` output — two integers where
 * the first is the "behind" count (in origin, not local) and the second is "ahead" (in local,
 * not origin).
 */
export function parseAheadBehind(output: string): { behind: number; ahead: number } {
	const parts = output.trim().split(/\s+/);
	if (parts.length !== 2) {
		throw new CliError("internal_error", `Unexpected \`git rev-list --left-right --count\` output: "${output}".`);
	}
	const behind = Number(parts[0]);
	const ahead = Number(parts[1]);
	if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
		throw new CliError("internal_error", `Unexpected \`git rev-list --left-right --count\` output: "${output}".`);
	}
	return { behind, ahead };
}

/**
 * Prepend `-c gc.auto=0` to a git invocation. The repo may hold broken
 * `refs/kanban/checkpoints/…` refs that make the automatic repack during fetch/push fail; the
 * task ceremony must not trip over them, so every network/tagging git op disables auto-gc.
 */
export function withGcDisabled(args: string[]): string[] {
	return ["-c", "gc.auto=0", ...args];
}

export interface GitHubRepoSlug {
	owner: string;
	repo: string;
}

/**
 * Extract the `owner/repo` from a github.com remote URL (https, scp-like `git@…:…`, or
 * `ssh://…`). Returns `null` for non-github or unparseable remotes — the Actions link is
 * best-effort, so a non-github origin simply yields no link rather than an error.
 */
export function parseGitHubRepoSlug(remoteUrl: string): GitHubRepoSlug | null {
	const trimmed = remoteUrl.trim();
	// scp-like SSH: git@github.com:owner/repo(.git)
	const scpMatch = /^[^@\s]+@github\.com:(.+)$/i.exec(trimmed);
	const path = scpMatch
		? scpMatch[1]
		: (/^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/(.+)$/i.exec(trimmed)?.[1] ?? null);
	if (path === null) {
		return null;
	}
	const segments = path
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "")
		.split("/");
	if (segments.length < 2 || !segments[0] || !segments[1]) {
		return null;
	}
	return { owner: segments[0], repo: segments[1] };
}

/** URL of the `build-release.yml` workflow's runs for a repo — the ceremony's CI destination. */
export function buildActionsUrl(slug: GitHubRepoSlug): string {
	return `https://github.com/${slug.owner}/${slug.repo}/actions/workflows/build-release.yml`;
}

/**
 * Replace the **top-level** `"version"` field in raw `package.json` text, preserving all other
 * formatting (indentation, key order, trailing newline). A targeted text replace rather than a
 * `JSON.parse`/`stringify` round-trip avoids gratuitous formatting churn in the release commit.
 * Anchored to the exact current version and to the first occurrence, so a dependency that
 * happens to pin the same version string is never touched (the top-level field comes first).
 * Throws {@link CliError} `internal_error` when the current version field is absent.
 */
export function applyVersionToPackageJson(
	packageJsonText: string,
	previousVersion: string,
	nextVersion: string,
): string {
	const escaped = previousVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`("version"\\s*:\\s*")${escaped}(")`);
	if (!pattern.test(packageJsonText)) {
		throw new CliError("internal_error", `Could not find "version": "${previousVersion}" in package.json to update.`);
	}
	return packageJsonText.replace(pattern, `$1${nextVersion}$2`);
}

export interface ReleasePlanInput {
	previousVersion: string;
	nextVersion: string;
	branch: string;
	remote: string;
}

export interface ReleasePlan {
	previousVersion: string;
	nextVersion: string;
	tag: string;
	commitMessage: string;
	branch: string;
	remote: string;
}

/**
 * Build the concrete release plan: the tag is `v<version>` and the commit message is
 * `v<version> release`, replicating the manual ceremony (decision d10e2). The tag deliberately
 * equals the `package.json` version so `npm pack` produces `kanban-<version>.tgz`.
 */
export function buildReleasePlan(input: ReleasePlanInput): ReleasePlan {
	return {
		previousVersion: input.previousVersion,
		nextVersion: input.nextVersion,
		tag: `v${input.nextVersion}`,
		commitMessage: `v${input.nextVersion} release`,
		branch: input.branch,
		remote: input.remote,
	};
}

/** Human-readable ordered list of the steps the plan performs (for `--dry-run` and the footer). */
export function describeReleaseSteps(plan: ReleasePlan): string[] {
	return [
		`Bump package.json + package-lock.json to ${plan.nextVersion}`,
		`git commit -m "${plan.commitMessage}"`,
		`git tag ${plan.tag}`,
		`git push ${plan.remote} ${plan.branch}`,
		`git push ${plan.remote} ${plan.tag}`,
	];
}

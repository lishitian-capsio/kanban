/**
 * `kanban release` — automate the release *ceremony* (vault decision d10e2). Kanban is a pure
 * orchestrator here: it bumps the version, commits, tags, and pushes; the actual build/pack is
 * delegated to the project's own CI. Pushing the `v<version>` tag triggers `build-release.yml`
 * (npm pack → GitHub Release with `generate_release_notes`), so this command NEVER runs
 * `npm publish` (that would publish to the upstream public `kanban` package) and never builds
 * a changelog by hand.
 *
 *   kanban release            — patch bump (default), full ceremony
 *   kanban release --minor    — minor bump
 *   kanban release 0.2.0      — explicit target version (positional; `--version` is reserved
 *                               by the root `-v, --version` flag, so the exact version is a
 *                               positional here, like `npm version <x.y.z>`)
 *   kanban release --dry-run  — print the plan (version/commit/tag/push) without pushing
 *
 * All version arithmetic, precheck evaluation, and command construction live in the pure
 * `release-plan.ts`; this module is the I/O shell (git, package.json, `npm`, the best-effort
 * Actions-link lookup).
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { getGitHubAuthService } from "../github-auth";
import { createLogger } from "../logging";
import { readGitHeadInfo, readGitRemoteUrl, registerGitCredentialInjector, runGit } from "../workspace/git-utils";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import { CliError } from "./cli-envelope";
import {
	applyVersionToPackageJson,
	buildActionsUrl,
	buildReleasePlan,
	describeReleaseSteps,
	evaluateReleasePrechecks,
	parseAheadBehind,
	parseGitHubRepoSlug,
	type ReleasePlan,
	resolveReleaseVersion,
	withGcDisabled,
} from "./release-plan";

const log = createLogger("commands.release");
const execFileAsync = promisify(execFile);

/** The remote every release pushes to. */
const RELEASE_REMOTE = "origin";
/** Wall-clock cap for the network git ops (fetch/push) so a stalled connection can't hang the CLI. */
const NETWORK_GIT_TIMEOUT_MS = 120_000;

interface ReleaseCommandOptions {
	patch?: boolean;
	minor?: boolean;
	major?: boolean;
	dryRun?: boolean;
	remote?: string;
}

/**
 * Run a git op through `runGit`, throwing a structured {@link CliError} on failure. Git
 * failures (including network fetch/push errors and timeouts) map to `internal_error` — the
 * error message is self-explanatory, and `runtime_unreachable` is avoided because its human
 * hint ("Is the Kanban runtime running?") is misleading for a git remote error.
 */
async function git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
	const result = await runGit(cwd, args, timeoutMs !== undefined ? { timeoutMs } : {});
	if (!result.ok) {
		throw new CliError("internal_error", result.error || `git ${args.join(" ")} failed.`);
	}
	return result.stdout;
}

/**
 * Resolve the default branch from `origin/HEAD` (`git symbolic-ref refs/remotes/origin/HEAD`),
 * falling back to `main` when it is not configured — the common case for a repo whose remote
 * HEAD was never recorded locally.
 */
async function resolveDefaultBranch(cwd: string): Promise<string> {
	const result = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (result.ok && result.stdout.trim()) {
		return result.stdout.trim().replace(/^origin\//, "");
	}
	return "main";
}

/** True when `git status --porcelain` reports no changes. */
async function isWorkingTreeClean(cwd: string): Promise<boolean> {
	const status = await git(cwd, ["status", "--porcelain"]);
	return status.trim() === "";
}

/** True when `refs/tags/<tag>` already exists locally. */
async function tagExists(cwd: string, tag: string): Promise<boolean> {
	const result = await runGit(cwd, ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]);
	return result.ok && result.stdout.trim() !== "";
}

/**
 * Best-effort lookup of the most recent `build-release.yml` run URL via the `gh` CLI. Returns
 * `null` on any failure (gh missing, not authenticated, no runs yet) — the caller always has
 * the workflow-runs page URL as a fallback, and a failure here must never fail the release.
 */
async function findLatestBuildReleaseRunUrl(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			["run", "list", "--workflow", "build-release.yml", "--limit", "1", "--json", "url"],
			{ cwd, timeout: 15_000 },
		);
		const parsed = JSON.parse(stdout) as Array<{ url?: unknown }>;
		const url = parsed[0]?.url;
		return typeof url === "string" ? url : null;
	} catch (error) {
		log.debug("Could not query the latest build-release run via gh.", { error });
		return null;
	}
}

interface ReleaseGitFacts {
	currentBranch: string | null;
	defaultBranch: string;
	workingTreeClean: boolean;
	behind: number;
	ahead: number;
}

/** Fetch the remote and gather every fact the prechecks need. */
async function gatherGitFacts(cwd: string, remote: string): Promise<ReleaseGitFacts> {
	const defaultBranch = await resolveDefaultBranch(cwd);
	// Fetch so the ahead/behind comparison reflects the true remote tip. Read-only, so it runs
	// in dry-run too; a failure means we cannot verify sync, which is a hard stop.
	const fetch = await runGit(cwd, withGcDisabled(["fetch", remote, defaultBranch]), {
		timeoutMs: NETWORK_GIT_TIMEOUT_MS,
	});
	if (!fetch.ok) {
		throw new CliError(
			"internal_error",
			`Could not fetch ${remote}/${defaultBranch} to verify sync: ${fetch.error ?? "unknown error"}`,
		);
	}
	const head = await readGitHeadInfo(cwd);
	const workingTreeClean = await isWorkingTreeClean(cwd);
	const range = `${remote}/${defaultBranch}...HEAD`;
	const revList = await git(cwd, ["rev-list", "--left-right", "--count", range]);
	const { ahead, behind } = parseAheadBehind(revList);
	return { currentBranch: head.branch, defaultBranch, workingTreeClean, behind, ahead };
}

/** Write the bumped version into package.json, then sync package-lock.json via npm. */
async function bumpVersionFiles(cwd: string, previousVersion: string, nextVersion: string): Promise<void> {
	const packageJsonPath = path.join(cwd, "package.json");
	const original = await readFile(packageJsonPath, "utf8");
	await writeFile(packageJsonPath, applyVersionToPackageJson(original, previousVersion, nextVersion));
	// `npm install --package-lock-only` regenerates package-lock.json from the new package.json
	// without touching node_modules; `--ignore-scripts` avoids lifecycle side effects.
	try {
		await execFileAsync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd, timeout: 300_000 });
	} catch (error) {
		throw new CliError(
			"internal_error",
			`Failed to sync package-lock.json via npm: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Execute the commit → tag → push steps that mutate git and trigger CI. */
async function executeReleasePlan(cwd: string, plan: ReleasePlan): Promise<{ commit: string }> {
	await bumpVersionFiles(cwd, plan.previousVersion, plan.nextVersion);
	await git(cwd, ["add", "package.json", "package-lock.json"]);
	await git(cwd, withGcDisabled(["commit", "-m", plan.commitMessage]));
	await git(cwd, withGcDisabled(["tag", plan.tag]));
	await git(cwd, withGcDisabled(["push", plan.remote, plan.branch]), NETWORK_GIT_TIMEOUT_MS);
	// Pushing the tag is what triggers `build-release.yml`.
	await git(cwd, withGcDisabled(["push", plan.remote, plan.tag]), NETWORK_GIT_TIMEOUT_MS);
	const commit = await git(cwd, ["rev-parse", "HEAD"]);
	return { commit };
}

async function runRelease(
	options: ReleaseCommandOptions,
	explicitVersion: string | undefined,
	projectPath?: string,
): Promise<Record<string, unknown>> {
	const cwd = projectPath ? path.resolve(projectPath) : process.cwd();
	const remote = options.remote?.trim() || RELEASE_REMOTE;

	// The CLI runs standalone (no runtime server), so the git credential injectors that
	// `startServer()` normally registers are absent. Register the GitHub source here so the
	// authenticated push uses the same host-keyed helper as the runtime (idempotent).
	registerGitCredentialInjector("github", () => getGitHubAuthService().getGitInjection());

	const packageJsonPath = path.join(cwd, "package.json");
	let currentVersion: string;
	try {
		const raw = await readFile(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		if (typeof parsed.version !== "string") {
			throw new CliError("internal_error", `package.json at ${packageJsonPath} has no string "version" field.`);
		}
		currentVersion = parsed.version;
	} catch (error) {
		if (error instanceof CliError) {
			throw error;
		}
		throw new CliError(
			"invalid_argument",
			`Could not read package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const resolved = resolveReleaseVersion(currentVersion, {
		patch: options.patch,
		minor: options.minor,
		major: options.major,
		explicit: explicitVersion,
	});

	const facts = await gatherGitFacts(cwd, remote);
	const prechecks = evaluateReleasePrechecks(facts);
	if (!prechecks.ok) {
		throw new CliError("validation_failed", `Release prechecks failed:\n  - ${prechecks.failures.join("\n  - ")}`, {
			failures: prechecks.failures,
		});
	}

	const plan = buildReleasePlan({
		previousVersion: resolved.previousVersion,
		nextVersion: resolved.nextVersion,
		branch: facts.defaultBranch,
		remote,
	});

	if (await tagExists(cwd, plan.tag)) {
		throw new CliError("validation_failed", `Tag ${plan.tag} already exists. Bump to a new version.`);
	}

	const remoteUrl = await readGitRemoteUrl(cwd);
	const slug = remoteUrl ? parseGitHubRepoSlug(remoteUrl) : null;
	const actionsUrl = slug ? buildActionsUrl(slug) : null;
	const steps = describeReleaseSteps(plan);

	if (options.dryRun) {
		return {
			dryRun: true,
			previousVersion: plan.previousVersion,
			version: plan.nextVersion,
			bump: resolved.bump,
			tag: plan.tag,
			branch: plan.branch,
			remote: plan.remote,
			commitMessage: plan.commitMessage,
			pushed: false,
			steps,
			actionsUrl,
		};
	}

	const { commit } = await executeReleasePlan(cwd, plan);
	const actionsRunUrl = slug ? await findLatestBuildReleaseRunUrl(cwd) : null;

	return {
		dryRun: false,
		previousVersion: plan.previousVersion,
		version: plan.nextVersion,
		bump: resolved.bump,
		tag: plan.tag,
		branch: plan.branch,
		remote: plan.remote,
		commit,
		commitMessage: plan.commitMessage,
		pushed: true,
		steps,
		actionsRunUrl,
		actionsUrl,
	};
}

function renderRelease(data: Record<string, unknown>): string {
	const lines: string[] = [];
	const dryRun = data.dryRun === true;
	lines.push(dryRun ? "Release plan (dry run — nothing was pushed):" : "Release complete:");
	lines.push(`  Version: ${data.previousVersion} → ${data.version} (${String(data.bump)})`);
	lines.push(`  Tag:     ${data.tag}`);
	lines.push(`  Branch:  ${data.remote}/${data.branch}`);
	if (typeof data.commit === "string") {
		lines.push(`  Commit:  ${data.commit}`);
	}
	if (Array.isArray(data.steps)) {
		lines.push(dryRun ? "  Would run:" : "  Ran:");
		for (const step of data.steps as string[]) {
			lines.push(`    - ${step}`);
		}
	}
	if (typeof data.actionsRunUrl === "string") {
		lines.push(`  Actions: ${data.actionsRunUrl}`);
	} else if (typeof data.actionsUrl === "string") {
		lines.push(`  Actions: ${data.actionsUrl}`);
	}
	if (dryRun) {
		lines.push("  Re-run without --dry-run to bump, tag, and push.");
	}
	return lines.join("\n");
}

export function registerReleaseCommand(program: Command): void {
	program
		.command("release")
		.description("Bump the version, commit, tag, and push to trigger the build-release CI (no npm publish).")
		.argument(
			"[version]",
			"Release an explicit x.y.z version instead of a bump level (`--version` is reserved by the global -v flag).",
		)
		.option("--patch", "Increment the patch version (default).")
		.option("--minor", "Increment the minor version.")
		.option("--major", "Increment the major version.")
		.option("--dry-run", "Print the planned version/commit/tag/push without mutating or pushing anything.")
		.addHelpText(
			"after",
			[
				"",
				"Examples:",
				"  kanban release            # patch bump + full ceremony",
				"  kanban release --minor    # minor bump",
				"  kanban release 0.2.0      # explicit target version",
				"  kanban release --dry-run  # preview without pushing",
				"",
			].join("\n"),
		)
		.action(async function (this: Command, versionArg: string | undefined) {
			const globals = readGlobalCliOptions(this);
			const options = this.opts() as ReleaseCommandOptions;
			await runCliCommand("release", async () => runRelease(options, versionArg, globals.projectPath), {
				globals,
				renderHuman: renderRelease,
				spinner: {
					text: "Running release ceremony…",
					succeedText: (data) => (data.dryRun === true ? "Release plan ready." : `Released ${String(data.tag)}.`),
					failText: "Release failed.",
				},
			});
		});
}

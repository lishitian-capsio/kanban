import { describe, expect, it } from "vitest";
import { CliError } from "../../src/commands/cli-envelope";
import {
	applyVersionToPackageJson,
	buildActionsUrl,
	buildReleasePlan,
	compareVersions,
	describeReleaseSteps,
	evaluateReleasePrechecks,
	formatVersion,
	parseAheadBehind,
	parseGitHubRepoSlug,
	parseReleaseVersion,
	resolveReleaseVersion,
	withGcDisabled,
} from "../../src/commands/release-plan";

describe("parseReleaseVersion", () => {
	it("parses a strict x.y.z version", () => {
		expect(parseReleaseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
	});

	it("parses versions with a leading v", () => {
		expect(parseReleaseVersion("v0.1.69")).toEqual({ major: 0, minor: 1, patch: 69 });
	});

	it("rejects a prerelease suffix", () => {
		expect(() => parseReleaseVersion("1.2.3-beta.1")).toThrow(CliError);
	});

	it("rejects a non-numeric or partial version", () => {
		expect(() => parseReleaseVersion("1.2")).toThrow(CliError);
		expect(() => parseReleaseVersion("abc")).toThrow(CliError);
		expect(() => parseReleaseVersion("1.2.x")).toThrow(CliError);
	});
});

describe("formatVersion", () => {
	it("renders the canonical x.y.z string", () => {
		expect(formatVersion({ major: 1, minor: 2, patch: 3 })).toBe("1.2.3");
	});
});

describe("compareVersions", () => {
	it("orders by major, then minor, then patch", () => {
		expect(compareVersions(parseReleaseVersion("1.0.0"), parseReleaseVersion("0.9.9"))).toBe(1);
		expect(compareVersions(parseReleaseVersion("0.1.69"), parseReleaseVersion("0.1.70"))).toBe(-1);
		expect(compareVersions(parseReleaseVersion("1.2.3"), parseReleaseVersion("1.2.3"))).toBe(0);
	});
});

describe("resolveReleaseVersion", () => {
	it("defaults to a patch bump", () => {
		expect(resolveReleaseVersion("0.1.69", {})).toEqual({
			previousVersion: "0.1.69",
			nextVersion: "0.1.70",
			bump: "patch",
		});
	});

	it("bumps minor and resets patch", () => {
		expect(resolveReleaseVersion("0.1.69", { minor: true })).toEqual({
			previousVersion: "0.1.69",
			nextVersion: "0.2.0",
			bump: "minor",
		});
	});

	it("bumps major and resets minor + patch", () => {
		expect(resolveReleaseVersion("0.1.69", { major: true })).toEqual({
			previousVersion: "0.1.69",
			nextVersion: "1.0.0",
			bump: "major",
		});
	});

	it("uses an explicit version when strictly greater than current", () => {
		expect(resolveReleaseVersion("0.1.69", { explicit: "0.2.5" })).toEqual({
			previousVersion: "0.1.69",
			nextVersion: "0.2.5",
			bump: "explicit",
		});
	});

	it("rejects an explicit version not greater than current", () => {
		expect(() => resolveReleaseVersion("0.1.69", { explicit: "0.1.69" })).toThrow(CliError);
		expect(() => resolveReleaseVersion("0.1.69", { explicit: "0.1.5" })).toThrow(CliError);
	});

	it("rejects combining --version with a bump level", () => {
		expect(() => resolveReleaseVersion("0.1.69", { explicit: "0.2.0", patch: true })).toThrow(CliError);
	});

	it("rejects combining multiple bump levels", () => {
		expect(() => resolveReleaseVersion("0.1.69", { minor: true, major: true })).toThrow(CliError);
	});
});

describe("evaluateReleasePrechecks", () => {
	const clean = {
		currentBranch: "main",
		defaultBranch: "main",
		workingTreeClean: true,
		ahead: 0,
		behind: 0,
	};

	it("passes when on the default branch, clean, and in sync", () => {
		expect(evaluateReleasePrechecks(clean)).toEqual({ ok: true, failures: [] });
	});

	it("fails when not on the default branch", () => {
		const result = evaluateReleasePrechecks({ ...clean, currentBranch: "feature" });
		expect(result.ok).toBe(false);
		expect(result.failures.join(" ")).toContain("main");
	});

	it("fails on a detached HEAD", () => {
		const result = evaluateReleasePrechecks({ ...clean, currentBranch: null });
		expect(result.ok).toBe(false);
	});

	it("fails when the working tree is dirty", () => {
		const result = evaluateReleasePrechecks({ ...clean, workingTreeClean: false });
		expect(result.ok).toBe(false);
		expect(result.failures.join(" ")).toContain("uncommitted");
	});

	it("fails when behind origin", () => {
		const result = evaluateReleasePrechecks({ ...clean, behind: 2 });
		expect(result.ok).toBe(false);
		expect(result.failures.join(" ")).toContain("behind");
	});

	it("fails when ahead of origin", () => {
		const result = evaluateReleasePrechecks({ ...clean, ahead: 3 });
		expect(result.ok).toBe(false);
		expect(result.failures.join(" ")).toContain("ahead");
	});

	it("collects multiple failures at once", () => {
		const result = evaluateReleasePrechecks({
			currentBranch: "feature",
			defaultBranch: "main",
			workingTreeClean: false,
			ahead: 1,
			behind: 1,
		});
		expect(result.ok).toBe(false);
		expect(result.failures.length).toBeGreaterThanOrEqual(3);
	});
});

describe("parseAheadBehind", () => {
	it("parses `git rev-list --left-right --count` output (behind then ahead)", () => {
		expect(parseAheadBehind("2\t3")).toEqual({ behind: 2, ahead: 3 });
	});

	it("tolerates arbitrary whitespace", () => {
		expect(parseAheadBehind("  0   0  ")).toEqual({ behind: 0, ahead: 0 });
	});

	it("throws on unparseable output", () => {
		expect(() => parseAheadBehind("nope")).toThrow(CliError);
	});
});

describe("withGcDisabled", () => {
	it("prepends -c gc.auto=0 to the git args", () => {
		expect(withGcDisabled(["push", "origin", "v1.0.0"])).toEqual(["-c", "gc.auto=0", "push", "origin", "v1.0.0"]);
	});
});

describe("parseGitHubRepoSlug", () => {
	it("parses an https remote", () => {
		expect(parseGitHubRepoSlug("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses an https remote without a .git suffix", () => {
		expect(parseGitHubRepoSlug("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses an scp-like ssh remote", () => {
		expect(parseGitHubRepoSlug("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses an ssh:// remote", () => {
		expect(parseGitHubRepoSlug("ssh://git@github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("returns null for a non-github host", () => {
		expect(parseGitHubRepoSlug("https://gitlab.com/owner/repo.git")).toBeNull();
	});

	it("returns null for garbage", () => {
		expect(parseGitHubRepoSlug("not a url")).toBeNull();
	});
});

describe("buildActionsUrl", () => {
	it("points at the build-release workflow runs", () => {
		expect(buildActionsUrl({ owner: "owner", repo: "repo" })).toBe(
			"https://github.com/owner/repo/actions/workflows/build-release.yml",
		);
	});
});

describe("applyVersionToPackageJson", () => {
	const pkg = ["{", '  "name": "kanban",', '  "version": "0.1.69",', '  "description": "x"', "}", ""].join("\n");

	it("replaces only the top-level version field and preserves formatting", () => {
		const next = applyVersionToPackageJson(pkg, "0.1.69", "0.1.70");
		expect(next).toBe(
			["{", '  "name": "kanban",', '  "version": "0.1.70",', '  "description": "x"', "}", ""].join("\n"),
		);
	});

	it("does not touch a dependency that happens to share the old version string", () => {
		const withDep = [
			"{",
			'  "name": "kanban",',
			'  "version": "0.1.69",',
			'  "dependencies": { "foo": "0.1.69" }',
			"}",
			"",
		].join("\n");
		const next = applyVersionToPackageJson(withDep, "0.1.69", "0.1.70");
		expect(next).toContain('"version": "0.1.70"');
		expect(next).toContain('"foo": "0.1.69"');
	});

	it("throws when the current version field is not found", () => {
		expect(() => applyVersionToPackageJson(pkg, "9.9.9", "9.9.10")).toThrow(CliError);
	});
});

describe("buildReleasePlan / describeReleaseSteps", () => {
	it("derives the tag and commit message from the next version", () => {
		const plan = buildReleasePlan({
			previousVersion: "0.1.69",
			nextVersion: "0.1.70",
			branch: "main",
			remote: "origin",
		});
		expect(plan).toEqual({
			previousVersion: "0.1.69",
			nextVersion: "0.1.70",
			tag: "v0.1.70",
			commitMessage: "v0.1.70 release",
			branch: "main",
			remote: "origin",
		});
	});

	it("describes the ordered release steps", () => {
		const steps = describeReleaseSteps(
			buildReleasePlan({ previousVersion: "0.1.69", nextVersion: "0.1.70", branch: "main", remote: "origin" }),
		);
		expect(steps).toEqual([
			"Bump package.json + package-lock.json to 0.1.70",
			'git commit -m "v0.1.70 release"',
			"git tag v0.1.70",
			"git push origin main",
			"git push origin v0.1.70",
		]);
	});
});

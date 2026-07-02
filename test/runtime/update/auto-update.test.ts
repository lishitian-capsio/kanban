import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	clearPendingUpdateNotification,
	compareVersions,
	detectAutoUpdateInstallation,
	downloadReleaseAssetToTemp,
	getPendingUpdateNotification,
	type ReleaseAsset,
	type ResolvedRelease,
	resolveLatestReleaseFromGitHub,
	resolveUpdateCommandForPlatform,
	runAutoUpdateCheck,
	runOnDemandUpdate,
	runPendingAutoUpdateOnShutdown,
	UpdatePackageManager,
} from "../../../src/update/update";

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}

function expectPathEndsWith(actualPath: string | undefined, expectedSuffix: string): void {
	expect(actualPath).toBeDefined();
	expect(normalizePath(actualPath ?? "").endsWith(expectedSuffix)).toBe(true);
}

function makeAsset(version: string): ReleaseAsset {
	return {
		name: `kanban-${version}.tgz`,
		downloadUrl: `https://github.com/cline/kanban/releases/download/v${version}/kanban-${version}.tgz`,
		apiUrl: `https://api.github.com/repos/cline/kanban/releases/assets/123`,
	};
}

function makeRelease(version: string, withAsset = true): ResolvedRelease {
	return {
		version,
		tgzAsset: withAsset ? makeAsset(version) : null,
	};
}

afterEach(() => {
	runPendingAutoUpdateOnShutdown({
		spawnUpdate: () => {},
		log: () => {},
	});
	clearPendingUpdateNotification();
	vi.restoreAllMocks();
});

describe("compareVersions", () => {
	it("supports semantic versions with prerelease values", () => {
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-nightly.12", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0-nightly.12", "1.0.0-nightly.2")).toBeGreaterThan(0);
	});
});

describe("resolveUpdateCommandForPlatform", () => {
	it("keeps command names unchanged on non-windows platforms", () => {
		expect(resolveUpdateCommandForPlatform("npm", "darwin")).toBe("npm");
		expect(resolveUpdateCommandForPlatform("pnpm", "linux")).toBe("pnpm");
	});

	it("maps package manager commands to .cmd on windows", () => {
		expect(resolveUpdateCommandForPlatform("npm", "win32")).toBe("npm.cmd");
		expect(resolveUpdateCommandForPlatform("pnpm", "win32")).toBe("pnpm.cmd");
		expect(resolveUpdateCommandForPlatform("yarn", "win32")).toBe("yarn.cmd");
	});

	it("does not rewrite non-cmd commands on windows", () => {
		expect(resolveUpdateCommandForPlatform("bun", "win32")).toBe("bun");
		expect(resolveUpdateCommandForPlatform(process.execPath, "win32")).toBe(process.execPath);
	});
});

describe("detectAutoUpdateInstallation", () => {
	it("marks workspace-local execution as local and non-updatable", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/workspace/kanban/dist/cli.js",
			cwd: "/workspace/kanban",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.LOCAL);
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.updateTiming).toBe("startup");
	});

	it("marks global npm installs with a global tgz install command", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/usr/local/lib/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.NPM);
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.globalInstall).toEqual({ command: "npm", installArgs: ["install", "-g"] });
		expect(installation.updateTiming).toBe("startup");
		expect(installation.releaseChannel).toBe("latest");
	});

	it("uses the nightly channel for nightly builds", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0-nightly.5",
			packageName: "kanban",
			entrypointPath: "/usr/local/lib/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.releaseChannel).toBe("nightly");
	});

	it("resolves pnpm/yarn/bun global install verbs", () => {
		const pnpm = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/Library/pnpm/global/5/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});
		expect(pnpm.globalInstall).toEqual({ command: "pnpm", installArgs: ["add", "-g"] });

		const yarn = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/.yarn/global/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});
		expect(yarn.globalInstall).toEqual({ command: "yarn", installArgs: ["global", "add"] });

		const bun = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/.bun/bin/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});
		expect(bun.globalInstall).toEqual({ command: "bun", installArgs: ["add", "-g"] });
	});

	it("marks npx installs for shutdown-time cache refresh", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.NPX);
		expect(installation.updateTiming).toBe("shutdown");
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand?.command).toBe(process.execPath);
		expect(installation.cacheRefreshCommand?.args[0]).toBe("-e");
		expect(typeof installation.cacheRefreshCommand?.args[1]).toBe("string");
		expectPathEndsWith(installation.cacheRefreshCommand?.args[2], "/Users/saoud/.npm/_npx/593b71878a7c70f2");
	});

	it("marks npm-cache npx installs for shutdown-time cache refresh", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/AppData/Local/npm-cache/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.NPX);
		expect(installation.updateTiming).toBe("shutdown");
		expect(installation.cacheRefreshCommand?.command).toBe(process.execPath);
		expect(installation.cacheRefreshCommand?.args[0]).toBe("-e");
		expect(typeof installation.cacheRefreshCommand?.args[1]).toBe("string");
		expectPathEndsWith(
			installation.cacheRefreshCommand?.args[2],
			"/Users/saoud/AppData/Local/npm-cache/_npx/593b71878a7c70f2",
		);
	});

	it("marks pnpm dlx installs for shutdown-time cache refresh", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath:
				"/Users/saoud/Library/Caches/pnpm/dlx/82fa34f6d8482ef2103aa281bbfd9bc42aeec4c8b99d8b1d6bc4653f9d4d179d/19cd9b46385-11271/node_modules/.pnpm/kanban@1.0.0/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.PNPM);
		expect(installation.updateTiming).toBe("shutdown");
		expect(installation.cacheRefreshCommand?.command).toBe(process.execPath);
		expect(installation.cacheRefreshCommand?.args[0]).toBe("-e");
		expect(typeof installation.cacheRefreshCommand?.args[1]).toBe("string");
		expectPathEndsWith(
			installation.cacheRefreshCommand?.args[2],
			"/Users/saoud/Library/Caches/pnpm/dlx/82fa34f6d8482ef2103aa281bbfd9bc42aeec4c8b99d8b1d6bc4653f9d4d179d/19cd9b46385-11271",
		);
	});

	it("marks bunx installs for shutdown-time cache refresh", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/private/tmp/bunx-501-kanban@1.0.0/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.BUN);
		expect(installation.updateTiming).toBe("shutdown");
		expect(installation.cacheRefreshCommand?.command).toBe(process.execPath);
		expect(installation.cacheRefreshCommand?.args[0]).toBe("-e");
		expect(typeof installation.cacheRefreshCommand?.args[1]).toBe("string");
		expectPathEndsWith(installation.cacheRefreshCommand?.args[2], "/private/tmp/bunx-501-kanban@1.0.0");
	});

	it("marks yarn dlx installs for shutdown-time cache refresh", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath:
				"/private/var/folders/v5/vpxh_439455fv8f_y_55m8q00000gn/T/xfs-bf17b212/dlx-39615/.yarn/cache/kanban-npm-1.0.0-abcdef1234.zip/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.YARN);
		expect(installation.updateTiming).toBe("shutdown");
		expect(installation.cacheRefreshCommand?.command).toBe(process.execPath);
		expect(installation.cacheRefreshCommand?.args[0]).toBe("-e");
		expect(typeof installation.cacheRefreshCommand?.args[1]).toBe("string");
		expectPathEndsWith(
			installation.cacheRefreshCommand?.args[2],
			"/private/var/folders/v5/vpxh_439455fv8f_y_55m8q00000gn/T/xfs-bf17b212/dlx-39615",
		);
	});

	it("treats workspace-local paths as local before transient heuristics", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/projects/work/.npm/_npx/demo/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.LOCAL);
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.updateTiming).toBe("startup");
	});

	it("fails closed for malformed npx-style paths", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/.npm/_npx/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.UNKNOWN);
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.updateTiming).toBe("startup");
	});

	it("fails closed for malformed npm-cache npx-style paths", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/AppData/Local/npm-cache/_npx/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.UNKNOWN);
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.updateTiming).toBe("startup");
	});

	it("fails closed for malformed pnpm dlx paths", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/Users/saoud/Library/Caches/pnpm/dlx/hashonly/node_modules/kanban/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.UNKNOWN);
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.updateTiming).toBe("startup");
	});

	it("fails closed for transient-looking paths that are not kanban", () => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "1.0.0",
			packageName: "kanban",
			entrypointPath: "/private/tmp/bunx-501-otherpkg@1.0.0/node_modules/otherpkg/dist/cli.js",
			cwd: "/Users/saoud/projects/work",
		});

		expect(installation.packageManager).toBe(UpdatePackageManager.UNKNOWN);
		expect(installation.globalInstall).toBeNull();
		expect(installation.cacheRefreshCommand).toBeNull();
		expect(installation.updateTiming).toBe("startup");
	});
});

describe("resolveLatestReleaseFromGitHub", () => {
	it("reads the latest stable release and strips a leading v from the tag", async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						tag_name: "v1.2.3",
						assets: [
							{
								name: "kanban-1.2.3.tgz",
								browser_download_url: "https://github.com/cline/kanban/releases/download/v1.2.3/kanban-1.2.3.tgz",
								url: "https://api.github.com/repos/cline/kanban/releases/assets/9",
							},
						],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const release = await resolveLatestReleaseFromGitHub({
			releaseChannel: "latest",
			repo: "cline/kanban",
			token: null,
		});

		expect(release).toEqual({
			version: "1.2.3",
			tgzAsset: {
				name: "kanban-1.2.3.tgz",
				downloadUrl: "https://github.com/cline/kanban/releases/download/v1.2.3/kanban-1.2.3.tgz",
				apiUrl: "https://api.github.com/repos/cline/kanban/releases/assets/9",
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.github.com/repos/cline/kanban/releases/latest");
		expect((init as RequestInit | undefined)?.headers).not.toHaveProperty("Authorization");
	});

	it("passes a bearer token when authenticated", async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ tag_name: "1.2.3", assets: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await resolveLatestReleaseFromGitHub({ releaseChannel: "latest", repo: "cline/kanban", token: "secret-token" });

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
	});

	it("finds the newest prerelease for the nightly channel", async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify([
						{ tag_name: "v1.2.3", prerelease: false, assets: [] },
						{
							tag_name: "v1.3.0-nightly.4",
							prerelease: true,
							assets: [
								{
									name: "kanban-1.3.0-nightly.4.tgz",
									browser_download_url: "https://example.test/nightly.tgz",
									url: "https://api.github.com/repos/cline/kanban/releases/assets/42",
								},
							],
						},
					]),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const release = await resolveLatestReleaseFromGitHub({
			releaseChannel: "nightly",
			repo: "cline/kanban",
			token: null,
		});

		expect(release?.version).toBe("1.3.0-nightly.4");
		expect(release?.tgzAsset?.name).toBe("kanban-1.3.0-nightly.4.tgz");
		expect(fetchMock.mock.calls[0]?.[0]).toContain("/releases?per_page=");
	});

	it("returns null when the release has no tgz asset", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						tag_name: "1.2.3",
						assets: [{ name: "kanban-1.2.3.zip", browser_download_url: "https://x/y.zip", url: "https://x/api" }],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const release = await resolveLatestReleaseFromGitHub({
			releaseChannel: "latest",
			repo: "cline/kanban",
			token: null,
		});

		expect(release?.version).toBe("1.2.3");
		expect(release?.tgzAsset).toBeNull();
	});

	it("degrades to null on a network failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);

		const release = await resolveLatestReleaseFromGitHub({
			releaseChannel: "latest",
			repo: "cline/kanban",
			token: null,
		});

		expect(release).toBeNull();
	});

	it("degrades to null on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		const release = await resolveLatestReleaseFromGitHub({
			releaseChannel: "latest",
			repo: "cline/kanban",
			token: null,
		});

		expect(release).toBeNull();
	});
});

describe("downloadReleaseAssetToTemp", () => {
	it("follows the GitHub 302 redirect without leaking the Authorization header", async () => {
		const storageUrl = "https://objects.githubusercontent.com/signed-blob";
		const payload = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("api.github.com")) {
				return new Response(null, { status: 302, headers: { location: storageUrl } });
			}
			return new Response(payload, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const asset = makeAsset("1.2.3");
		const filePath = await downloadReleaseAssetToTemp(asset, "secret-token");

		expect(filePath).toBeTruthy();
		const contents = await readFile(filePath ?? "");
		expect(new Uint8Array(contents)).toEqual(payload);
		if (filePath) {
			await rm(filePath, { force: true });
		}

		// First call hits the API url with auth; the redirect follow must NOT re-send it.
		const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect((firstInit?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
		expect(fetchMock.mock.calls[0]?.[0]).toBe(asset.apiUrl);

		const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
		expect((secondInit?.headers as Record<string, string>).Authorization).toBeUndefined();
		expect(fetchMock.mock.calls[1]?.[0]).toBe(storageUrl);
	});

	it("uses the public download url anonymously when there is no token", async () => {
		const payload = new Uint8Array([9, 9]);
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) => new Response(payload, { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const asset = makeAsset("1.2.3");
		const filePath = await downloadReleaseAssetToTemp(asset, null);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(asset.downloadUrl);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
		if (filePath) {
			await rm(filePath, { force: true });
		}
	});

	it("degrades to null on a download failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("boom");
			}),
		);

		expect(await downloadReleaseAssetToTemp(makeAsset("1.2.3"), null)).toBeNull();
	});
});

describe("runOnDemandUpdate", () => {
	it("downloads the release tgz and runs a global install when a newer version is available", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];
		const downloadedAssets: ReleaseAsset[] = [];

		const result = await runOnDemandUpdate({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async (asset) => {
				downloadedAssets.push(asset);
				return "/tmp/kanban-update-abc/kanban-1.1.0.tgz";
			},
			runUpdateCommand: (command, args) => {
				spawnedUpdates.push({ command, args });
				return 0;
			},
		});

		expect(result.status).toBe("updated");
		expect(result.latestVersion).toBe("1.1.0");
		expect(downloadedAssets).toHaveLength(1);
		expect(spawnedUpdates).toEqual([
			{
				command: "npm",
				args: ["install", "-g", "/tmp/kanban-update-abc/kanban-1.1.0.tgz"],
			},
		]);
	});

	it("returns already_up_to_date when current version matches latest", async () => {
		let downloadCalled = false;
		let runUpdateCalled = false;

		const result = await runOnDemandUpdate({
			currentVersion: "1.1.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => {
				downloadCalled = true;
				return null;
			},
			runUpdateCommand: () => {
				runUpdateCalled = true;
				return 0;
			},
		});

		expect(result.status).toBe("already_up_to_date");
		expect(downloadCalled).toBe(false);
		expect(runUpdateCalled).toBe(false);
	});

	it("reports check_failed when the release probe fails", async () => {
		const result = await runOnDemandUpdate({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => null,
			downloadReleaseAsset: async () => "/tmp/should-not-happen.tgz",
			runUpdateCommand: () => 0,
		});

		expect(result.status).toBe("check_failed");
		expect(result.latestVersion).toBeNull();
	});

	it("reports update_failed when the release has no tgz asset", async () => {
		let downloadCalled = false;

		const result = await runOnDemandUpdate({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0", false),
			downloadReleaseAsset: async () => {
				downloadCalled = true;
				return null;
			},
			runUpdateCommand: () => 0,
		});

		expect(result.status).toBe("update_failed");
		expect(result.latestVersion).toBe("1.1.0");
		expect(downloadCalled).toBe(false);
	});

	it("reports update_failed when the asset download fails", async () => {
		const result = await runOnDemandUpdate({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => null,
			runUpdateCommand: () => 0,
		});

		expect(result.status).toBe("update_failed");
	});

	it("updates local workspace installs via the npm global tgz fallback", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];

		const result = await runOnDemandUpdate({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/workspace/kanban/dist/cli.js"],
			cwd: "/workspace/kanban",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => "/tmp/kanban-1.1.0.tgz",
			runUpdateCommand: (command, args) => {
				spawnedUpdates.push({ command, args });
				return 0;
			},
		});

		expect(result.status).toBe("updated");
		expect(result.packageManager).toBe(UpdatePackageManager.NPM);
		expect(spawnedUpdates).toEqual([
			{
				command: "npm",
				args: ["install", "-g", "/tmp/kanban-1.1.0.tgz"],
			},
		]);
	});

	it("refreshes transient npx cache without downloading when a newer version exists", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];
		let downloadCalled = false;

		const result = await runOnDemandUpdate({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/Users/saoud/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => {
				downloadCalled = true;
				return null;
			},
			runUpdateCommand: (command, args) => {
				spawnedUpdates.push({ command, args });
				return 0;
			},
		});

		expect(result.status).toBe("cache_refreshed");
		expect(downloadCalled).toBe(false);
		expect(spawnedUpdates).toHaveLength(1);
		expect(spawnedUpdates[0]?.command).toBe(process.execPath);
		expect(spawnedUpdates[0]?.args[0]).toBe("-e");
	});
});

describe("runAutoUpdateCheck", () => {
	it("downloads and spawns a global update when a newer version is available", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];

		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => "/tmp/kanban-1.1.0.tgz",
			spawnUpdate: (command, args) => {
				spawnedUpdates.push({ command, args });
			},
		});

		expect(spawnedUpdates).toEqual([
			{
				command: "npm",
				args: ["install", "-g", "/tmp/kanban-1.1.0.tgz"],
			},
		]);
	});

	it("does not spawn when the release asset download fails", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];

		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => null,
			spawnUpdate: (command, args) => {
				spawnedUpdates.push({ command, args });
			},
		});

		expect(spawnedUpdates).toEqual([]);
	});

	it("schedules transient cache refresh until shutdown", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];

		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/Users/saoud/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => {
				throw new Error("transient update should not download");
			},
			spawnUpdate: (command, args) => {
				spawnedUpdates.push({ command, args });
			},
		});

		expect(spawnedUpdates).toEqual([]);
	});

	it("flushes the pending transient cache refresh during shutdown", async () => {
		const spawnedUpdates: Array<{ command: string; args: string[] }> = [];
		const messages: string[] = [];

		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/Users/saoud/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			spawnUpdate: () => {
				throw new Error("transient update should not spawn immediately");
			},
		});

		runPendingAutoUpdateOnShutdown({
			spawnUpdate: (command, args) => {
				spawnedUpdates.push({ command, args });
			},
			log: (message) => {
				messages.push(message);
			},
		});

		expect(messages).toEqual(["New version 1.1.0 detected. Refreshing cached Kanban for next launch."]);
		expect(spawnedUpdates).toHaveLength(1);
		expect(spawnedUpdates[0]?.command).toBe(process.execPath);
		expect(spawnedUpdates[0]?.args[0]).toBe("-e");
		expect(typeof spawnedUpdates[0]?.args[1]).toBe("string");
		expectPathEndsWith(spawnedUpdates[0]?.args[2], "/Users/saoud/.npm/_npx/593b71878a7c70f2");
	});

	it("checks for updates on each startup without persisted state", async () => {
		let resolveCalls = 0;
		let spawnCalls = 0;

		const options = {
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path: string) => path,
			resolveLatestRelease: async () => {
				resolveCalls += 1;
				return makeRelease("1.1.0");
			},
			downloadReleaseAsset: async () => "/tmp/kanban-1.1.0.tgz",
			spawnUpdate: () => {
				spawnCalls += 1;
			},
		};

		await runAutoUpdateCheck(options);
		await runAutoUpdateCheck(options);

		expect(resolveCalls).toBe(2);
		expect(spawnCalls).toBe(2);
	});

	it("skips update checks when KANBAN_NO_AUTO_UPDATE is set", async () => {
		let resolveCalled = false;

		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: { KANBAN_NO_AUTO_UPDATE: "1" },
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => {
				resolveCalled = true;
				return makeRelease("1.1.0");
			},
			spawnUpdate: () => {
				throw new Error("should not spawn");
			},
		});

		expect(resolveCalled).toBe(false);
	});
});

describe("getPendingUpdateNotification", () => {
	it("returns null when no update check has detected a new version", () => {
		expect(getPendingUpdateNotification()).toBeNull();
	});

	it("records a pending notification pointing at `kanban update` for global installs", async () => {
		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => "/tmp/kanban-1.1.0.tgz",
			spawnUpdate: () => {},
		});

		expect(getPendingUpdateNotification()).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			updateTiming: "startup",
			installCommand: "kanban update",
		});
	});

	it("records a pending notification for shutdown-timing transient installs", async () => {
		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/Users/saoud/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			spawnUpdate: () => {},
		});

		expect(getPendingUpdateNotification()).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			updateTiming: "shutdown",
			installCommand: "npx kanban",
		});
	});

	it("uses pnpm dlx as the install command for pnpm-dlx transient installs", async () => {
		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: [
				"node",
				"/Users/saoud/Library/Caches/pnpm/dlx/82fa34f6d8482ef2103aa281bbfd9bc42aeec4c8b99d8b1d6bc4653f9d4d179d/19cd9b46385-11271/node_modules/.pnpm/kanban@1.0.0/node_modules/kanban/dist/cli.js",
			],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			spawnUpdate: () => {},
		});

		expect(getPendingUpdateNotification()).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			updateTiming: "shutdown",
			installCommand: "pnpm dlx kanban",
		});
	});

	it("uses yarn dlx as the install command for yarn-dlx transient installs", async () => {
		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: [
				"node",
				"/private/var/folders/v5/vpxh_439455fv8f_y_55m8q00000gn/T/xfs-bf17b212/dlx-39615/.yarn/cache/kanban-npm-1.0.0-abcdef1234.zip/node_modules/kanban/dist/cli.js",
			],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			spawnUpdate: () => {},
		});

		expect(getPendingUpdateNotification()).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			updateTiming: "shutdown",
			installCommand: "yarn dlx kanban",
		});
	});

	it("uses bunx as the install command for bunx transient installs", async () => {
		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/private/tmp/bunx-501-kanban@1.0.0/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			spawnUpdate: () => {},
		});

		expect(getPendingUpdateNotification()).toEqual({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			updateTiming: "shutdown",
			installCommand: "bunx kanban",
		});
	});

	it("leaves the pending notification null when the current version is already latest", async () => {
		await runAutoUpdateCheck({
			currentVersion: "1.1.0",
			packageName: "kanban",
			argv: ["node", "/usr/local/lib/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => makeRelease("1.1.0"),
			downloadReleaseAsset: async () => "/tmp/kanban-1.1.0.tgz",
			spawnUpdate: () => {},
		});

		expect(getPendingUpdateNotification()).toBeNull();
	});

	it("leaves the pending notification null for unknown installations", async () => {
		let resolveCalled = false;

		await runAutoUpdateCheck({
			currentVersion: "1.0.0",
			packageName: "kanban",
			argv: ["node", "/Users/saoud/.npm/_npx/node_modules/kanban/dist/cli.js"],
			cwd: "/Users/saoud/projects/work",
			env: {},
			resolveRealPath: (path) => path,
			resolveLatestRelease: async () => {
				resolveCalled = true;
				return makeRelease("1.1.0");
			},
			spawnUpdate: () => {
				throw new Error("unknown installation should not update");
			},
		});

		expect(resolveCalled).toBe(false);
		expect(getPendingUpdateNotification()).toBeNull();
	});
});

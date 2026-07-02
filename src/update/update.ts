import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildSubprocessProxyEnv } from "../config/proxy-fetch";
import { getGitHubAuthService } from "../github-auth";
import { createLogger } from "../logging";

const log = createLogger("update");

/**
 * Kanban self-update is sourced from **GitHub Releases**, not the npm registry: the latest
 * version is discovered from the repo's releases and the installable artifact is the
 * `npm pack`-produced `.tgz` attached as a release asset (see `.github/workflows/`).
 *
 * The default is the repo that actually publishes those tgz releases — the `origin` remote /
 * RELEASE-GUIDE repo, NOT the `cline/kanban` upstream that README/package.json still point at.
 * Override with `KANBAN_UPDATE_GITHUB_REPO=owner/repo` to point at a fork or private mirror.
 */
const DEFAULT_UPDATE_GITHUB_REPO = "Capsio-Technology/kanban";

/** GitHub REST API host (behind the runtime's globalThis.fetch proxy monkey-patch). */
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const UPDATE_USER_AGENT = "kanban-cli-self-update";

/** The release probe stays snappy (mirrors the old 2.5s registry probe); the download gets longer. */
const RELEASE_PROBE_TIMEOUT_MS = 4_000;
const ASSET_DOWNLOAD_TIMEOUT_MS = 120_000;

/** How many recent releases to scan when locating the newest prerelease for the nightly channel. */
const NIGHTLY_RELEASE_SCAN_COUNT = 30;

export enum UpdatePackageManager {
	NPM = "npm",
	PNPM = "pnpm",
	YARN = "yarn",
	BUN = "bun",
	NPX = "npx",
	LOCAL = "local",
	UNKNOWN = "unknown",
}

interface UpdateInstallCommand {
	command: string;
	args: string[];
}

/**
 * How to run a package manager's **global install of a local `.tgz` file**. `installArgs` is
 * the verb prefix (e.g. `["install", "-g"]`); the resolved downloaded tgz path is appended at
 * install time by {@link buildGlobalInstallCommand}.
 */
interface GlobalInstallSpec {
	command: string;
	installArgs: string[];
}

interface UpdateInstallationInfo {
	packageManager: UpdatePackageManager;
	/** Release channel: `"latest"` (stable) or `"nightly"` (newest prerelease). */
	releaseChannel: ReleaseChannel;
	updateTiming: "startup" | "shutdown";
	/**
	 * Transient (dlx/npx/bunx) installs: clearing the launcher cache so the next invocation
	 * re-fetches. A complete command; no download/tgz install is involved.
	 */
	cacheRefreshCommand: UpdateInstallCommand | null;
	/** Persistent global installs: how to globally install the downloaded release tgz. */
	globalInstall: GlobalInstallSpec | null;
}

type ReleaseChannel = "latest" | "nightly";

/** A `.tgz` release asset located on a GitHub release. */
export interface ReleaseAsset {
	name: string;
	/** Public, redirect-following download URL (`browser_download_url`). */
	downloadUrl: string;
	/** Asset REST API URL; used with `Accept: application/octet-stream` for private repos. */
	apiUrl: string;
}

/** The result of probing GitHub Releases for the newest version on a channel. */
export interface ResolvedRelease {
	/** `tag_name` with any leading `v` stripped, so it compares against the package version. */
	version: string;
	tgzAsset: ReleaseAsset | null;
}

type ResolveLatestRelease = (input: { releaseChannel: ReleaseChannel }) => Promise<ResolvedRelease | null>;
type DownloadReleaseAsset = (asset: ReleaseAsset) => Promise<string | null>;

export interface UpdateStartupOptions {
	currentVersion: string;
	packageName?: string;
	env?: NodeJS.ProcessEnv;
	argv?: string[];
	cwd?: string;
	resolveRealPath?: (path: string) => string;
	resolveLatestRelease?: ResolveLatestRelease;
	downloadReleaseAsset?: DownloadReleaseAsset;
	spawnUpdate?: (command: string, args: string[]) => void;
	scheduleShutdownUpdate?: (update: PendingShutdownAutoUpdate) => void;
}

export interface OnDemandUpdateOptions extends UpdateStartupOptions {
	runUpdateCommand?: (command: string, args: string[]) => number;
}

export type OnDemandUpdateStatus =
	| "updated"
	| "already_up_to_date"
	| "cache_refreshed"
	| "unsupported_installation"
	| "check_failed"
	| "update_failed";

export interface OnDemandUpdateResult {
	status: OnDemandUpdateStatus;
	currentVersion: string;
	latestVersion: string | null;
	packageManager: UpdatePackageManager;
	message: string;
}

interface ParsedVersion {
	core: number[];
	prerelease: Array<number | string> | null;
}

interface PendingShutdownAutoUpdate {
	command: string;
	args: string[];
	latestVersion: string;
}

export interface PendingUpdateNotification {
	currentVersion: string;
	latestVersion: string;
	updateTiming: "startup" | "shutdown";
	installCommand: string;
}

function buildUserFacingInstallCommand(
	packageManager: UpdatePackageManager,
	packageName: string,
	updateTiming: "startup" | "shutdown",
): string | null {
	// `updateTiming === "shutdown"` marks transient (dlx / npx / bunx) runs: the user did not
	// perform a global install, so the right advice is to re-run the same launcher (which
	// re-fetches the newest published version) rather than steer them toward `... add -g`.
	if (updateTiming === "shutdown") {
		switch (packageManager) {
			case UpdatePackageManager.PNPM:
				return `pnpm dlx ${packageName}`;
			case UpdatePackageManager.YARN:
				return `yarn dlx ${packageName}`;
			case UpdatePackageManager.BUN:
				return `bunx ${packageName}`;
			case UpdatePackageManager.NPX:
				return `npx ${packageName}`;
			default:
				return null;
		}
	}
	// Persistent global installs are updated by the built-in updater, which downloads and
	// installs the GitHub Release tgz for the detected package manager. There is no simple
	// one-liner the user can paste (the tgz is a temp file), so point them at `kanban update`.
	return `${packageName} update`;
}

const DELETE_DIRECTORY_AFTER_DELAY_SCRIPT = `
const { rmSync } = require("node:fs");

const targetDirectory = process.argv[1];
if (!targetDirectory) {
	process.exit(0);
}

setTimeout(() => {
	try {
		rmSync(targetDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
	} catch {}
}, 750);
`.trim();

let pendingShutdownAutoUpdate: PendingShutdownAutoUpdate | null = null;
let pendingUpdateNotification: PendingUpdateNotification | null = null;

export function getPendingUpdateNotification(): PendingUpdateNotification | null {
	return pendingUpdateNotification;
}

export function clearPendingUpdateNotification(): void {
	pendingUpdateNotification = null;
}

function toPosixLowerPath(path: string): string {
	return path.replaceAll("\\", "/").toLowerCase();
}

function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function isPathInside(targetPath: string, containerPath: string): boolean {
	const normalizedTarget = toPosixLowerPath(resolve(targetPath));
	const normalizedContainer = toPosixLowerPath(resolve(containerPath));
	if (normalizedTarget === normalizedContainer) {
		return true;
	}
	return normalizedTarget.startsWith(`${normalizedContainer}/`);
}

function isNightlyVersion(version: string): boolean {
	return version.includes("-nightly.");
}

function getReleaseChannel(currentVersion: string): ReleaseChannel {
	return isNightlyVersion(currentVersion) ? "nightly" : "latest";
}

function parseVersion(version: string): ParsedVersion {
	const versionWithoutBuild = version.split("+", 1)[0] ?? "";
	const [corePart, prereleasePart] = versionWithoutBuild.split("-", 2);
	const core = corePart
		.split(".")
		.filter((part) => part.length > 0)
		.map((part) => Number.parseInt(part, 10));
	const prerelease = prereleasePart
		? prereleasePart
				.split(".")
				.filter((part) => part.length > 0)
				.map((part) => (/^\d+$/u.test(part) ? Number.parseInt(part, 10) : part))
		: null;
	return {
		core,
		prerelease,
	};
}

function buildShutdownCacheRefreshCommand(cacheDirectory: string): UpdateInstallCommand {
	return {
		command: process.execPath,
		args: ["-e", DELETE_DIRECTORY_AFTER_DELAY_SCRIPT, cacheDirectory],
	};
}

function buildGlobalInstallCommand(spec: GlobalInstallSpec, tgzPath: string): UpdateInstallCommand {
	return {
		command: spec.command,
		args: [...spec.installArgs, tgzPath],
	};
}

function splitResolvedPath(path: string): {
	hasLeadingSlash: boolean;
	segments: string[];
	normalizedSegments: string[];
} {
	const resolvedPath = toPosixPath(resolve(path));
	const hasLeadingSlash = resolvedPath.startsWith("/");
	const segments = resolvedPath.split("/").filter((_segment, index) => !(hasLeadingSlash && index === 0));
	return {
		hasLeadingSlash,
		segments,
		normalizedSegments: segments.map((segment) => segment.toLowerCase()),
	};
}

function buildDirectoryFromSegments(segments: string[], hasLeadingSlash: boolean, endIndex: number): string | null {
	if (endIndex <= 0 || segments.length < endIndex) {
		return null;
	}
	const directory = segments.slice(0, endIndex).join("/");
	if (directory.length === 0) {
		return null;
	}
	return hasLeadingSlash ? `/${directory}` : directory;
}

function findSegmentSequence(segments: string[], sequence: string[]): number {
	if (sequence.length === 0 || segments.length < sequence.length) {
		return -1;
	}

	for (let index = 0; index <= segments.length - sequence.length; index += 1) {
		let matches = true;
		for (let offset = 0; offset < sequence.length; offset += 1) {
			if (segments[index + offset] !== sequence[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return index;
		}
	}

	return -1;
}

function extractDirectoryForSegmentSequence(
	entrypointPath: string,
	sequences: string[][],
	trailingSegmentCount: number,
): string | null {
	const { hasLeadingSlash, segments, normalizedSegments } = splitResolvedPath(entrypointPath);

	for (const sequence of sequences) {
		const sequenceIndex = findSegmentSequence(normalizedSegments, sequence);
		if (sequenceIndex < 0) {
			continue;
		}
		const endIndex = sequenceIndex + sequence.length + trailingSegmentCount;
		const requiredSegments = normalizedSegments.slice(sequenceIndex + sequence.length, endIndex);
		if (
			requiredSegments.length !== trailingSegmentCount ||
			requiredSegments.some(
				(segment) => segment.length === 0 || segment === "." || segment === ".." || segment === "node_modules",
			)
		) {
			continue;
		}
		const directory = buildDirectoryFromSegments(segments, hasLeadingSlash, endIndex);
		if (directory) {
			return directory;
		}
	}

	return null;
}

function extractDirectoryForSegmentPattern(entrypointPath: string, pattern: RegExp): string | null {
	const { hasLeadingSlash, segments, normalizedSegments } = splitResolvedPath(entrypointPath);
	const matchingIndex = normalizedSegments.findIndex((segment) => pattern.test(segment));
	return buildDirectoryFromSegments(segments, hasLeadingSlash, matchingIndex + 1);
}

function looksLikeTransientCachePath(path: string): boolean {
	const normalizedPath = toPosixLowerPath(path);
	return (
		normalizedPath.includes("/.npm/_npx/") ||
		normalizedPath.includes("/npm/_npx/") ||
		normalizedPath.includes("/npm-cache/_npx/") ||
		normalizedPath.includes("/.npx/") ||
		normalizedPath.includes("/pnpm/dlx/") ||
		normalizedPath.includes("/.yarn/cache/") ||
		normalizedPath.includes("/bunx-")
	);
}

function detectTransientAutoUpdateInstallation(options: {
	currentVersion: string;
	packageName: string;
	entrypointPath: string;
}): UpdateInstallationInfo | null {
	const releaseChannel = getReleaseChannel(options.currentVersion);
	const normalizedPath = toPosixLowerPath(options.entrypointPath);

	if (!normalizedPath.includes(`/node_modules/${options.packageName.toLowerCase()}/`)) {
		return null;
	}

	const npxCacheDirectory = extractDirectoryForSegmentSequence(
		options.entrypointPath,
		[[".npm", "_npx"], ["npm", "_npx"], ["npm-cache", "_npx"], [".npx"]],
		1,
	);
	if (npxCacheDirectory) {
		return {
			packageManager: UpdatePackageManager.NPX,
			releaseChannel,
			cacheRefreshCommand: buildShutdownCacheRefreshCommand(npxCacheDirectory),
			globalInstall: null,
			updateTiming: "shutdown",
		};
	}

	const pnpmDlxCacheDirectory = extractDirectoryForSegmentSequence(options.entrypointPath, [["pnpm", "dlx"]], 2);
	if (pnpmDlxCacheDirectory) {
		return {
			packageManager: UpdatePackageManager.PNPM,
			releaseChannel,
			cacheRefreshCommand: buildShutdownCacheRefreshCommand(pnpmDlxCacheDirectory),
			globalInstall: null,
			updateTiming: "shutdown",
		};
	}

	const yarnDlxDirectory = extractDirectoryForSegmentPattern(options.entrypointPath, /^dlx-\d+$/u);
	if (yarnDlxDirectory) {
		return {
			packageManager: UpdatePackageManager.YARN,
			releaseChannel,
			cacheRefreshCommand: buildShutdownCacheRefreshCommand(yarnDlxDirectory),
			globalInstall: null,
			updateTiming: "shutdown",
		};
	}

	const bunxDirectory = extractDirectoryForSegmentPattern(options.entrypointPath, /^bunx-/u);
	if (bunxDirectory) {
		return {
			packageManager: UpdatePackageManager.BUN,
			releaseChannel,
			cacheRefreshCommand: buildShutdownCacheRefreshCommand(bunxDirectory),
			globalInstall: null,
			updateTiming: "shutdown",
		};
	}

	return null;
}

function comparePrereleaseParts(left: Array<number | string> | null, right: Array<number | string> | null): number {
	if (!left && !right) {
		return 0;
	}
	if (!left) {
		return 1;
	}
	if (!right) {
		return -1;
	}

	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = left[index];
		const rightPart = right[index];
		if (leftPart === undefined && rightPart === undefined) {
			return 0;
		}
		if (leftPart === undefined) {
			return -1;
		}
		if (rightPart === undefined) {
			return 1;
		}
		if (leftPart === rightPart) {
			continue;
		}
		if (typeof leftPart === "number" && typeof rightPart === "number") {
			return leftPart > rightPart ? 1 : -1;
		}
		if (typeof leftPart === "number") {
			return -1;
		}
		if (typeof rightPart === "number") {
			return 1;
		}
		return leftPart.localeCompare(rightPart);
	}
	return 0;
}

export function compareVersions(leftVersion: string, rightVersion: string): number {
	const left = parseVersion(leftVersion);
	const right = parseVersion(rightVersion);
	const length = Math.max(left.core.length, right.core.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = left.core[index] ?? 0;
		const rightPart = right.core[index] ?? 0;
		if (leftPart > rightPart) {
			return 1;
		}
		if (leftPart < rightPart) {
			return -1;
		}
	}
	return comparePrereleaseParts(left.prerelease, right.prerelease);
}

export function detectAutoUpdateInstallation(options: {
	currentVersion: string;
	packageName: string;
	entrypointPath: string;
	cwd: string;
}): UpdateInstallationInfo {
	const normalizedPath = toPosixLowerPath(options.entrypointPath);
	const releaseChannel = getReleaseChannel(options.currentVersion);

	if (isPathInside(options.entrypointPath, options.cwd)) {
		return {
			packageManager: UpdatePackageManager.LOCAL,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: null,
			updateTiming: "startup",
		};
	}

	const transientInstallation = detectTransientAutoUpdateInstallation({
		currentVersion: options.currentVersion,
		packageName: options.packageName,
		entrypointPath: options.entrypointPath,
	});
	if (transientInstallation) {
		return transientInstallation;
	}

	if (looksLikeTransientCachePath(options.entrypointPath)) {
		return {
			packageManager: UpdatePackageManager.UNKNOWN,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: null,
			updateTiming: "startup",
		};
	}

	if (normalizedPath.includes("/.pnpm/global/") || normalizedPath.includes("/pnpm/global/")) {
		return {
			packageManager: UpdatePackageManager.PNPM,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: { command: "pnpm", installArgs: ["add", "-g"] },
			updateTiming: "startup",
		};
	}

	if (normalizedPath.includes("/.yarn/") || normalizedPath.includes("/yarn/global/")) {
		return {
			packageManager: UpdatePackageManager.YARN,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: { command: "yarn", installArgs: ["global", "add"] },
			updateTiming: "startup",
		};
	}

	if (normalizedPath.includes("/.bun/bin/")) {
		return {
			packageManager: UpdatePackageManager.BUN,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: { command: "bun", installArgs: ["add", "-g"] },
			updateTiming: "startup",
		};
	}

	if (normalizedPath.includes(`/lib/node_modules/${options.packageName}/`)) {
		return {
			packageManager: UpdatePackageManager.NPM,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: { command: "npm", installArgs: ["install", "-g"] },
			updateTiming: "startup",
		};
	}

	if (normalizedPath.includes(`/node_modules/${options.packageName}/`)) {
		return {
			packageManager: UpdatePackageManager.NPM,
			releaseChannel,
			cacheRefreshCommand: null,
			globalInstall: { command: "npm", installArgs: ["install", "-g"] },
			updateTiming: "startup",
		};
	}

	return {
		packageManager: UpdatePackageManager.UNKNOWN,
		releaseChannel,
		cacheRefreshCommand: null,
		globalInstall: null,
		updateTiming: "startup",
	};
}

function isAutoUpdateDisabled(env: NodeJS.ProcessEnv): boolean {
	if (env.KANBAN_NO_AUTO_UPDATE === "1") {
		return true;
	}
	if (env.NODE_ENV === "test" || env.VITEST === "true") {
		return true;
	}
	if (env.CI === "true") {
		return true;
	}
	return false;
}

function resolveUpdateGitHubRepo(env: NodeJS.ProcessEnv): string {
	const override = env.KANBAN_UPDATE_GITHUB_REPO?.trim();
	return override?.includes("/") ? override : DEFAULT_UPDATE_GITHUB_REPO;
}

function buildGitHubApiHeaders(token: string | null): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": UPDATE_USER_AGENT,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

function stripLeadingV(tag: string): string {
	const trimmed = tag.trim();
	return trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseReleaseAsset(value: unknown): ReleaseAsset | null {
	if (!isRecord(value)) {
		return null;
	}
	const name = value.name;
	const downloadUrl = value.browser_download_url;
	const apiUrl = value.url;
	if (typeof name !== "string" || typeof downloadUrl !== "string" || typeof apiUrl !== "string") {
		return null;
	}
	return { name, downloadUrl, apiUrl };
}

/**
 * Locate the npm-pack `.tgz` asset on a release. Prefers an asset whose name embeds the
 * version (the `kanban-<version>.tgz` convention) but accepts any `.tgz` so a naming tweak
 * doesn't silently break updates.
 */
function selectTgzAsset(release: Record<string, unknown>): ReleaseAsset | null {
	const rawAssets = release.assets;
	if (!Array.isArray(rawAssets)) {
		return null;
	}
	const assets = rawAssets.map(parseReleaseAsset).filter((asset): asset is ReleaseAsset => asset !== null);
	const tgzAssets = assets.filter((asset) => asset.name.toLowerCase().endsWith(".tgz"));
	const version = typeof release.tag_name === "string" ? stripLeadingV(release.tag_name) : "";
	const versioned = version ? tgzAssets.find((asset) => asset.name.includes(version)) : undefined;
	return versioned ?? tgzAssets[0] ?? null;
}

function toResolvedRelease(release: Record<string, unknown>): ResolvedRelease | null {
	const tagName = release.tag_name;
	if (typeof tagName !== "string" || tagName.trim().length === 0) {
		return null;
	}
	return {
		version: stripLeadingV(tagName),
		tgzAsset: selectTgzAsset(release),
	};
}

/**
 * Probe GitHub Releases for the newest version on the requested channel. `latest` uses the
 * `releases/latest` endpoint (which excludes prereleases/drafts); `nightly` scans recent
 * releases for the newest prerelease. Network/parse failures degrade to `null` (never throw)
 * so a self-update check can never crash Kanban.
 */
export async function resolveLatestReleaseFromGitHub(input: {
	releaseChannel: ReleaseChannel;
	repo: string;
	token: string | null;
}): Promise<ResolvedRelease | null> {
	const headers = buildGitHubApiHeaders(input.token);
	try {
		if (input.releaseChannel === "nightly") {
			const response = await fetch(
				`${GITHUB_API_ORIGIN}/repos/${input.repo}/releases?per_page=${NIGHTLY_RELEASE_SCAN_COUNT}`,
				{ headers, signal: AbortSignal.timeout(RELEASE_PROBE_TIMEOUT_MS) },
			);
			if (!response.ok) {
				return null;
			}
			const payload = (await response.json()) as unknown;
			if (!Array.isArray(payload)) {
				return null;
			}
			const prerelease = payload.find(
				(release): release is Record<string, unknown> =>
					isRecord(release) && release.prerelease === true && release.draft !== true,
			);
			return prerelease ? toResolvedRelease(prerelease) : null;
		}

		const response = await fetch(`${GITHUB_API_ORIGIN}/repos/${input.repo}/releases/latest`, {
			headers,
			signal: AbortSignal.timeout(RELEASE_PROBE_TIMEOUT_MS),
		});
		if (!response.ok) {
			return null;
		}
		const payload = (await response.json()) as unknown;
		if (!isRecord(payload)) {
			return null;
		}
		return toResolvedRelease(payload);
	} catch {
		return null;
	}
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Download a release `.tgz` asset to a fresh temp file and return its path (or `null` on any
 * failure). With a token, the asset REST API URL is used with `Accept: application/octet-stream`
 * (works for private repos); GitHub answers with a 302 to codeload/object storage, which we
 * follow **without** re-sending the Authorization header (the signed URL carries its own auth
 * and a stray Authorization header is rejected by the storage backend).
 */
export async function downloadReleaseAssetToTemp(asset: ReleaseAsset, token: string | null): Promise<string | null> {
	try {
		const useApiUrl = token !== null;
		const initialUrl = useApiUrl ? asset.apiUrl : asset.downloadUrl;
		const initialHeaders: Record<string, string> = {
			"User-Agent": UPDATE_USER_AGENT,
			Accept: "application/octet-stream",
		};
		if (token) {
			initialHeaders.Authorization = `Bearer ${token}`;
		}

		let response = await fetch(initialUrl, {
			headers: initialHeaders,
			redirect: "manual",
			signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
		});
		if (isRedirectStatus(response.status)) {
			const location = response.headers.get("location");
			if (!location) {
				return null;
			}
			response = await fetch(location, {
				headers: { "User-Agent": UPDATE_USER_AGENT },
				signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
			});
		}
		if (!response.ok) {
			return null;
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length === 0) {
			return null;
		}
		const directory = await mkdtemp(join(tmpdir(), "kanban-update-"));
		const filePath = join(directory, basename(asset.name) || "kanban-release.tgz");
		await writeFile(filePath, bytes);
		return filePath;
	} catch (error) {
		log.debug("release asset download failed", { error });
		return null;
	}
}

async function resolveGitHubTokenSafely(): Promise<string | null> {
	try {
		return await getGitHubAuthService().getAccessToken();
	} catch (error) {
		log.debug("github token lookup for self-update failed; continuing anonymously", { error });
		return null;
	}
}

function createDefaultResolveLatestRelease(env: NodeJS.ProcessEnv): ResolveLatestRelease {
	const repo = resolveUpdateGitHubRepo(env);
	return async ({ releaseChannel }) => {
		const token = await resolveGitHubTokenSafely();
		return resolveLatestReleaseFromGitHub({ releaseChannel, repo, token });
	};
}

function createDefaultDownloadReleaseAsset(): DownloadReleaseAsset {
	return async (asset) => {
		const token = await resolveGitHubTokenSafely();
		return downloadReleaseAssetToTemp(asset, token);
	};
}

function spawnDetachedUpdate(command: string, args: string[]): void {
	const child = spawn(resolveUpdateCommandForPlatform(command), args, {
		detached: true,
		stdio: "ignore",
		// process.env no longer carries proxy vars (they latch Bun's in-process
		// fetch); merge the configured proxy explicitly for the package manager.
		env: { ...process.env, ...buildSubprocessProxyEnv() },
		windowsHide: true,
	});
	child.unref();
}

function runUpdateCommandSync(command: string, args: string[]): number {
	const result = spawnSync(resolveUpdateCommandForPlatform(command), args, {
		env: { ...process.env, ...buildSubprocessProxyEnv() },
		stdio: "inherit",
		windowsHide: true,
	});
	if (typeof result.status === "number") {
		return result.status;
	}
	return 1;
}

export function resolveUpdateCommandForPlatform(command: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") {
		return command;
	}

	if (command === "npm" || command === "pnpm" || command === "yarn") {
		return `${command}.cmd`;
	}

	return command;
}

function schedulePendingShutdownAutoUpdate(update: PendingShutdownAutoUpdate): void {
	pendingShutdownAutoUpdate = update;
}

export function runPendingAutoUpdateOnShutdown(options?: {
	spawnUpdate?: (command: string, args: string[]) => void;
	log?: (message: string) => void;
}): void {
	if (!pendingShutdownAutoUpdate) {
		return;
	}

	const pendingUpdate = pendingShutdownAutoUpdate;
	pendingShutdownAutoUpdate = null;

	const emit = options?.log ?? ((message: string) => log.info(message));
	emit(`New version ${pendingUpdate.latestVersion} detected. Refreshing cached Kanban for next launch.`);

	const spawnUpdate = options?.spawnUpdate ?? spawnDetachedUpdate;
	spawnUpdate(pendingUpdate.command, pendingUpdate.args);
}

/**
 * Local dev checkouts (`packageManager === LOCAL` with nothing to run) are treated as a manual
 * global npm install so `kanban update` still does something useful; every other installation
 * keeps whatever the detector resolved.
 */
function resolveManualInstallation(installation: UpdateInstallationInfo): UpdateInstallationInfo {
	if (installation.globalInstall || installation.cacheRefreshCommand) {
		return installation;
	}
	if (installation.packageManager !== UpdatePackageManager.LOCAL) {
		return installation;
	}
	return {
		packageManager: UpdatePackageManager.NPM,
		releaseChannel: installation.releaseChannel,
		updateTiming: "startup",
		cacheRefreshCommand: null,
		globalInstall: { command: "npm", installArgs: ["install", "-g"] },
	};
}

export async function runOnDemandUpdate(options: OnDemandUpdateOptions): Promise<OnDemandUpdateResult> {
	const env = options.env ?? process.env;
	const entrypointArg = options.argv?.[1] ?? process.argv[1];
	if (!entrypointArg) {
		return {
			status: "unsupported_installation",
			currentVersion: options.currentVersion,
			latestVersion: null,
			packageManager: UpdatePackageManager.UNKNOWN,
			message: "Could not resolve the Kanban entrypoint for this installation.",
		};
	}

	const resolveRealPath = options.resolveRealPath ?? ((path: string) => realpathSync(path));
	let entrypointPath: string;
	try {
		entrypointPath = resolveRealPath(entrypointArg);
	} catch {
		return {
			status: "unsupported_installation",
			currentVersion: options.currentVersion,
			latestVersion: null,
			packageManager: UpdatePackageManager.UNKNOWN,
			message: "Could not resolve the Kanban entrypoint for this installation.",
		};
	}

	const packageName = options.packageName ?? "kanban";
	const installation = detectAutoUpdateInstallation({
		currentVersion: options.currentVersion,
		packageName,
		entrypointPath,
		cwd: options.cwd ?? process.cwd(),
	});

	const manualInstallation = resolveManualInstallation(installation);
	if (!manualInstallation.globalInstall && !manualInstallation.cacheRefreshCommand) {
		return {
			status: "unsupported_installation",
			currentVersion: options.currentVersion,
			latestVersion: null,
			packageManager: manualInstallation.packageManager,
			message: "Could not determine an automatic update command for this Kanban installation.",
		};
	}

	const resolveLatestRelease = options.resolveLatestRelease ?? createDefaultResolveLatestRelease(env);
	const release = await resolveLatestRelease({ releaseChannel: manualInstallation.releaseChannel });
	if (!release) {
		return {
			status: "check_failed",
			currentVersion: options.currentVersion,
			latestVersion: null,
			packageManager: manualInstallation.packageManager,
			message: "Could not check the latest Kanban version from GitHub Releases.",
		};
	}

	if (compareVersions(options.currentVersion, release.version) >= 0) {
		return {
			status: "already_up_to_date",
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			packageManager: installation.packageManager,
			message: `Kanban is already up to date (${options.currentVersion}).`,
		};
	}

	const runUpdateCommand = options.runUpdateCommand ?? runUpdateCommandSync;

	// Transient (dlx/npx/bunx) installs: clear the launcher cache so the next invocation
	// re-fetches the newest published version. No tgz download/install is involved.
	if (manualInstallation.cacheRefreshCommand) {
		const exitCode = runUpdateCommand(
			manualInstallation.cacheRefreshCommand.command,
			manualInstallation.cacheRefreshCommand.args,
		);
		if (exitCode !== 0) {
			return {
				status: "update_failed",
				currentVersion: options.currentVersion,
				latestVersion: release.version,
				packageManager: manualInstallation.packageManager,
				message: `Update command failed with exit code ${exitCode}.`,
			};
		}
		return {
			status: "cache_refreshed",
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			packageManager: manualInstallation.packageManager,
			message: `Cleared transient Kanban cache. Re-run your command to launch version ${release.version}.`,
		};
	}

	const globalInstall = manualInstallation.globalInstall;
	if (!globalInstall) {
		return {
			status: "unsupported_installation",
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			packageManager: manualInstallation.packageManager,
			message: "Could not determine an automatic update command for this Kanban installation.",
		};
	}

	if (!release.tgzAsset) {
		return {
			status: "update_failed",
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			packageManager: manualInstallation.packageManager,
			message: `Release ${release.version} has no installable .tgz asset attached.`,
		};
	}

	const downloadReleaseAsset = options.downloadReleaseAsset ?? createDefaultDownloadReleaseAsset();
	const tgzPath = await downloadReleaseAsset(release.tgzAsset);
	if (!tgzPath) {
		return {
			status: "update_failed",
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			packageManager: manualInstallation.packageManager,
			message: `Could not download the Kanban ${release.version} release asset.`,
		};
	}

	const installCommand = buildGlobalInstallCommand(globalInstall, tgzPath);
	const exitCode = runUpdateCommand(installCommand.command, installCommand.args);
	if (exitCode !== 0) {
		return {
			status: "update_failed",
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			packageManager: manualInstallation.packageManager,
			message: `Update command failed with exit code ${exitCode}.`,
		};
	}

	return {
		status: "updated",
		currentVersion: options.currentVersion,
		latestVersion: release.version,
		packageManager: manualInstallation.packageManager,
		message: `Updated Kanban from ${options.currentVersion} to ${release.version}.`,
	};
}

export async function runAutoUpdateCheck(options: UpdateStartupOptions): Promise<void> {
	const env = options.env ?? process.env;
	if (isAutoUpdateDisabled(env)) {
		return;
	}

	const entrypointArg = options.argv?.[1] ?? process.argv[1];
	if (!entrypointArg) {
		return;
	}

	const resolveRealPath = options.resolveRealPath ?? ((path: string) => realpathSync(path));
	let entrypointPath: string;
	try {
		entrypointPath = resolveRealPath(entrypointArg);
	} catch {
		return;
	}

	const packageName = options.packageName ?? "kanban";
	const installation = detectAutoUpdateInstallation({
		currentVersion: options.currentVersion,
		packageName,
		entrypointPath,
		cwd: options.cwd ?? process.cwd(),
	});
	if (!installation.globalInstall && !installation.cacheRefreshCommand) {
		return;
	}

	const resolveLatestRelease = options.resolveLatestRelease ?? createDefaultResolveLatestRelease(env);
	const downloadReleaseAsset = options.downloadReleaseAsset ?? createDefaultDownloadReleaseAsset();
	const spawnUpdate = options.spawnUpdate ?? spawnDetachedUpdate;
	const scheduleShutdownUpdate = options.scheduleShutdownUpdate ?? schedulePendingShutdownAutoUpdate;

	try {
		const release = await resolveLatestRelease({ releaseChannel: installation.releaseChannel });

		if (!release || compareVersions(options.currentVersion, release.version) >= 0) {
			return;
		}

		const installCommand = buildUserFacingInstallCommand(
			installation.packageManager,
			packageName,
			installation.updateTiming,
		);
		if (!installCommand) {
			return;
		}

		pendingUpdateNotification = {
			currentVersion: options.currentVersion,
			latestVersion: release.version,
			updateTiming: installation.updateTiming,
			installCommand,
		};

		// Transient (dlx/npx/bunx) installs defer to shutdown: clearing the launcher cache mid
		// session would pull the running process's files out from under it.
		if (installation.cacheRefreshCommand) {
			scheduleShutdownUpdate({
				command: installation.cacheRefreshCommand.command,
				args: installation.cacheRefreshCommand.args,
				latestVersion: release.version,
			});
			return;
		}

		if (!installation.globalInstall || !release.tgzAsset) {
			return;
		}

		const tgzPath = await downloadReleaseAsset(release.tgzAsset);
		if (!tgzPath) {
			return;
		}

		const globalInstallCommand = buildGlobalInstallCommand(installation.globalInstall, tgzPath);
		spawnUpdate(globalInstallCommand.command, globalInstallCommand.args);
	} catch {
		return;
	}
}

export function autoUpdateOnStartup(options: UpdateStartupOptions): void {
	void runAutoUpdateCheck(options);
}

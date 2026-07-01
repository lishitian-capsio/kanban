import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile as readFileBytes,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	dirname as dirnameNative,
	isAbsolute as isAbsoluteNative,
	join as joinNative,
	relative as relativeNative,
	resolve,
} from "node:path";

import JSZip from "jszip";

import type {
	RuntimeFsCreateEntryRequest,
	RuntimeFsDeleteEntryRequest,
	RuntimeFsDeleteEntryResponse,
	RuntimeFsDownloadEntryRequest,
	RuntimeFsDownloadEntryResponse,
	RuntimeFsEntry,
	RuntimeFsEntryMutationResponse,
	RuntimeFsListDirRequest,
	RuntimeFsListDirResponse,
	RuntimeFsListPathsRequest,
	RuntimeFsListPathsResponse,
	RuntimeFsMoveRequest,
	RuntimeFsReadFileRequest,
	RuntimeFsReadFileResponse,
	RuntimeFsRenameRequest,
	RuntimeFsStatRequest,
	RuntimeFsStatResponse,
	RuntimeFsUploadFileRequest,
	RuntimeFsUploadFileResponse,
	RuntimeFsWriteFileRequest,
	RuntimeFsWriteFileResponse,
} from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { classifyFileCategory, detectMimeType } from "../files/file-mime";
import { createLogger } from "../logging";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { isPathWithinRoot } from "./path-sandbox";

const log = createLogger("workspace-fs");

// Text files above this are shown read-only-but-not-loaded (no content over the wire).
const FS_EDIT_MAX_BYTES = 1024 * 1024; // 1 MB
// Binary/preview payloads (base64) above this are not sent; the UI shows metadata only.
const FS_PREVIEW_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
// Download payload cap (a single file's bytes, or a directory zip's total
// uncompressed bytes). Bounds the in-memory base64 held for a download response.
const FS_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
// Upload payload cap (a single uploaded file's decoded bytes). Bounds the
// in-memory buffer decoded from the base64 upload request.
const FS_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
// Bytes sniffed from a file's head to decide binary-vs-text when the mime is unknown.
const BINARY_SNIFF_BYTES = 8192;

// Quick Open (`listPaths`) result caps: default when the client omits `limit`,
// and a hard ceiling it is clamped to. Bounds both the payload size and the
// client-side fzf index; over the cap the response is `truncated` (never silent).
const FS_LIST_PATHS_DEFAULT_CAP = 10000;
const FS_LIST_PATHS_MAX_CAP = 50000;
// `git ls-files` can emit the whole tree's path list at once; give it plenty of
// room (a path list is small per-entry but a monorepo has many). On overflow the
// spawn errors and we degrade to the bounded walk, which stops at the cap.
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;

// Directory names that are ALWAYS hidden regardless of `showHidden` — the git
// metadata dir and Kanban's own runtime/board home. Hidden at every depth.
const ALWAYS_HIDDEN_NAMES = new Set([".git", ".kanban"]);

// Extensions that are source/config TEXT but whose mime type misclassifies them
// as binary in the `mime` db (the notorious `.ts` → `video/mp2t`). This wins over
// the mime lookup so a code explorer never treats a TypeScript file as a video.
const TEXT_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonc",
	"json5",
	"css",
	"scss",
	"sass",
	"less",
	"html",
	"htm",
	"xml",
	"svg",
	"vue",
	"svelte",
	"astro",
	"md",
	"markdown",
	"mdx",
	"txt",
	"text",
	"log",
	"csv",
	"tsv",
	"rst",
	"adoc",
	"yml",
	"yaml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"properties",
	"editorconfig",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"cmd",
	"py",
	"pyi",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"kts",
	"c",
	"h",
	"cpp",
	"cc",
	"cxx",
	"hpp",
	"hh",
	"cs",
	"php",
	"lua",
	"sql",
	"graphql",
	"gql",
	"r",
	"swift",
	"m",
	"mm",
	"pl",
	"pm",
	"dart",
	"ex",
	"exs",
	"erl",
	"hs",
	"clj",
	"cljs",
	"scala",
	"groovy",
	"tf",
	"hcl",
	"proto",
	"prisma",
	"gradle",
	"cmake",
	"make",
	"mk",
	"patch",
	"diff",
	"lock",
	"gitignore",
	"gitattributes",
	"dockerignore",
	"npmrc",
	"nvmrc",
	"browserslistrc",
	"prettierrc",
	"eslintrc",
	"babelrc",
]);

// Common extensionless files that are text.
const TEXT_BASENAMES = new Set([
	"dockerfile",
	"makefile",
	"license",
	"readme",
	"changelog",
	"authors",
	"notice",
	"gemfile",
	"rakefile",
	"procfile",
	"brewfile",
	"vagrantfile",
	"codeowners",
]);

function isTextExtensionOrBasename(name: string): boolean {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot === -1) {
		return TEXT_BASENAMES.has(lower);
	}
	return TEXT_EXTENSIONS.has(lower.slice(dot + 1));
}

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GITIGNORE_CACHE_TTL_MS = 3000;

/**
 * Signals a request whose target path resolves outside the workspace root. The
 * router turns this into a friendly `{ ok: false, error }` rather than a 500.
 */
class OutsideRootError extends Error {
	constructor(message = "Path resolves outside the workspace root.") {
		super(message);
		this.name = "OutsideRootError";
	}
}

/**
 * Signals a mutation whose target touches an always-hidden engine directory
 * (`.git`/`.kanban`) at any depth. The explorer never lets these be created,
 * renamed, moved, or deleted through this surface.
 */
class ReservedPathError extends Error {
	constructor(message = "Cannot modify the .git or .kanban directory.") {
		super(message);
		this.name = "ReservedPathError";
	}
}

/** Map a path-safety rejection to its friendly message; otherwise a fallback. */
function mutationErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof OutsideRootError || error instanceof ReservedPathError) {
		return error.message;
	}
	return fallback;
}

/** Map a Node fs error code to a friendly message; otherwise a fallback. */
function fsSystemErrorMessage(error: unknown, fallback: string): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	switch (code) {
		case "ENOENT":
			return "The parent directory does not exist.";
		case "EEXIST":
			return "An entry with that name already exists.";
		case "ENOTEMPTY":
			return "Directory is not empty.";
		case "EACCES":
		case "EPERM":
			return "Permission denied.";
		default:
			return fallback;
	}
}

/**
 * Refuse any path whose components include an always-hidden engine dir at ANY
 * depth. Mutations must never create/rename/move/delete inside `.git`/`.kanban`.
 */
function assertNotReservedPath(inputPath: string | undefined): void {
	const normalized = (inputPath ?? "").replace(/\\/g, "/");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	if (segments.some((segment) => ALWAYS_HIDDEN_NAMES.has(segment))) {
		throw new ReservedPathError();
	}
}

/**
 * Validate a bare entry name (for `rename`): non-empty, not `.`/`..`, no path
 * separators (so it can only land in the same directory), not a reserved dir.
 * Returns an error message, or `null` when the name is acceptable.
 */
function validateBareName(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed === "") {
		return "Name cannot be empty.";
	}
	if (trimmed === "." || trimmed === "..") {
		return "That name is not allowed.";
	}
	if (/[\\/]/.test(trimmed)) {
		return "Name cannot contain a path separator.";
	}
	if (ALWAYS_HIDDEN_NAMES.has(trimmed)) {
		return "That name is reserved.";
	}
	return null;
}

/**
 * Symlink-escape guard for a target that does NOT yet exist (create/move dest):
 * resolve the real path of the target's PARENT and confirm it stays inside the
 * real root, so a symlinked parent can't be used to write outside the workspace.
 */
async function assertRealParentWithinRoot(root: string, target: string): Promise<void> {
	const realRoot = await realpath(root);
	const realParent = await realpath(dirnameNative(target));
	if (!isPathWithinRoot(realRoot, realParent)) {
		throw new OutsideRootError();
	}
}

function toPosixRelative(root: string, absolute: string): string {
	const rel = relativeNative(root, absolute);
	if (!rel) {
		return "";
	}
	return rel.split(/[\\/]/g).join("/");
}

/**
 * Resolve a client-supplied, repo-root-relative POSIX path against `root` and
 * assert it stays inside the root. Rejects absolute inputs and `..` traversal.
 * Does NOT touch the filesystem (no symlink resolution) — see `assertRealWithinRoot`.
 */
function resolveWithinRoot(root: string, inputPath: string | undefined): string {
	const raw = (inputPath ?? "").trim();
	// Normalize separators only — do NOT strip a leading slash, so an absolute
	// POSIX path can still be recognized and rejected below.
	const normalized = raw.replace(/\\/g, "/");
	if (normalized === "" || normalized === ".") {
		return resolve(root);
	}
	// Reject absolute paths outright (POSIX absolute, Windows drive letters, UNC).
	if (normalized.startsWith("/") || isAbsoluteNative(normalized) || /^[a-zA-Z]:/.test(normalized)) {
		throw new OutsideRootError();
	}
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	if (segments.some((segment) => segment === "..")) {
		throw new OutsideRootError();
	}
	const resolved = resolve(root, joinNative(...segments));
	if (!isPathWithinRoot(root, resolved)) {
		throw new OutsideRootError();
	}
	return resolved;
}

/**
 * Second-line defense against symlink escapes: after path-string sandboxing,
 * resolve the real (symlink-followed) path of both root and target and confirm
 * the target still lives inside the real root. Throws {@link OutsideRootError}
 * when a symlink points outside the workspace.
 */
async function assertRealWithinRoot(root: string, target: string): Promise<void> {
	const realRoot = await realpath(root);
	const realTarget = await realpath(target);
	if (!isPathWithinRoot(realRoot, realTarget)) {
		throw new OutsideRootError();
	}
}

// -----------------------------------------------------------------------------
// gitignore — one `git check-ignore` per listed directory, async + bounded +
// cached (short TTL, single-flight, invalidated on dir mtime change). Mirrors
// the caching discipline of `detectGitRepositoryInfo`. NEVER uses a sync spawn
// (AGENTS.md: "No sync subprocess on hot paths").
// -----------------------------------------------------------------------------

interface GitIgnoreProbe {
	isGitRepository: boolean;
	ignored: Set<string>;
}

interface GitIgnoreCacheEntry {
	dirMtimeMs: number;
	expiresAt: number;
	promise: Promise<GitIgnoreProbe>;
}

const gitIgnoreCache = new Map<string, GitIgnoreCacheEntry>();

/**
 * Run `git check-ignore --stdin -z` feeding NUL-separated repo-relative paths on
 * stdin and returning the subset git would ignore. `git check-ignore` exits 0
 * when ≥1 path is ignored, 1 when none are, and 128 on a fatal error (e.g. not a
 * git repo) — so a non-zero exit is not necessarily failure. We treat 0/1 as a
 * successful git probe and 128 (or spawn failure) as "not a git repository".
 */
function runCheckIgnore(root: string, relPaths: string[]): Promise<GitIgnoreProbe> {
	if (relPaths.length === 0) {
		return Promise.resolve({ isGitRepository: true, ignored: new Set<string>() });
	}
	return new Promise<GitIgnoreProbe>((resolvePromise) => {
		const child = execFile(
			"git",
			["check-ignore", "--stdin", "-z"],
			{ cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: createGitProcessEnv() },
			(error, stdout) => {
				const exitCode =
					error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
						? Number((error as { code: number }).code)
						: error
							? 128
							: 0;
				if (exitCode === 128) {
					// Not a git repository (or git unavailable): degrade gracefully.
					resolvePromise({ isGitRepository: false, ignored: new Set<string>() });
					return;
				}
				const ignored = new Set<string>();
				for (const line of (stdout ?? "").split("\0")) {
					const value = line.replace(/\\/g, "/");
					if (value) {
						ignored.add(value);
					}
				}
				resolvePromise({ isGitRepository: true, ignored });
			},
		);
		child.on("error", () => {
			resolvePromise({ isGitRepository: false, ignored: new Set<string>() });
		});
		child.stdin?.write(relPaths.join("\0"));
		child.stdin?.end();
	});
}

async function probeGitIgnored(root: string, dirAbs: string, relPaths: string[]): Promise<GitIgnoreProbe> {
	let dirMtimeMs = 0;
	try {
		dirMtimeMs = (await stat(dirAbs)).mtimeMs;
	} catch {
		// If we can't stat the dir, skip caching but still probe.
	}
	const now = Date.now();
	const cached = gitIgnoreCache.get(dirAbs);
	if (cached && cached.expiresAt > now && cached.dirMtimeMs === dirMtimeMs) {
		const probe = await cached.promise;
		// Re-derive the ignored subset for THIS call's paths from the cached full-dir probe.
		return { isGitRepository: probe.isGitRepository, ignored: probe.ignored };
	}
	const promise = runCheckIgnore(root, relPaths);
	gitIgnoreCache.set(dirAbs, { dirMtimeMs, expiresAt: now + GITIGNORE_CACHE_TTL_MS, promise });
	try {
		return await promise;
	} catch {
		gitIgnoreCache.delete(dirAbs);
		return { isGitRepository: false, ignored: new Set<string>() };
	}
}

// -----------------------------------------------------------------------------
// Entry building
// -----------------------------------------------------------------------------

async function buildEntry(root: string, absolute: string, name: string, gitIgnored: boolean): Promise<RuntimeFsEntry> {
	const link = await lstat(absolute);
	const isSymlink = link.isSymbolicLink();
	let kind: "file" | "dir" = link.isDirectory() ? "dir" : "file";
	let size = link.size;
	let mtimeMs = link.mtimeMs;

	if (isSymlink) {
		// Determine the symlink's target kind ONLY when it stays within the root;
		// never follow a link that escapes (design §4.3.2).
		try {
			const real = await realpath(absolute);
			const realRoot = await realpath(root);
			if (isPathWithinRoot(realRoot, real)) {
				const targetStat = await stat(absolute);
				kind = targetStat.isDirectory() ? "dir" : "file";
				size = targetStat.size;
				mtimeMs = targetStat.mtimeMs;
			} else {
				// Escaping symlink: surface it as a (non-followable) file.
				kind = "file";
			}
		} catch {
			kind = "file";
		}
	}

	return {
		name,
		path: toPosixRelative(root, absolute),
		kind,
		size,
		mtimeMs,
		isSymlink,
		gitIgnored,
	};
}

/**
 * Build an entry for a single known-good path, resolving its gitIgnored flag via
 * one `git check-ignore`. Used by `stat` and by the mutations to echo the
 * resulting entry for incremental tree refresh.
 */
async function buildEntryWithGitignore(root: string, absolute: string): Promise<RuntimeFsEntry> {
	const name = absolute.split(/[\\/]/g).pop() ?? "";
	const rel = toPosixRelative(root, absolute);
	let gitIgnored = false;
	try {
		const probe = await runCheckIgnore(root, [rel || name]);
		gitIgnored = probe.ignored.has(rel);
	} catch {
		gitIgnored = false;
	}
	return buildEntry(root, absolute, name, gitIgnored);
}

// -----------------------------------------------------------------------------
// listDir
// -----------------------------------------------------------------------------

export async function fsListDir(root: string, input: RuntimeFsListDirRequest): Promise<RuntimeFsListDirResponse> {
	const showHidden = input.showHidden === true;
	let dirAbs: string;
	try {
		dirAbs = resolveWithinRoot(root, input.path);
		await assertRealWithinRoot(root, dirAbs);
	} catch (error) {
		if (error instanceof OutsideRootError) {
			return { ok: false, path: input.path ?? "", entries: [], isGitRepository: false, error: error.message };
		}
		return {
			ok: false,
			path: input.path ?? "",
			entries: [],
			isGitRepository: false,
			error: "Directory not found.",
		};
	}

	const dirRel = toPosixRelative(root, dirAbs);

	let dirents: Dirent[];
	try {
		dirents = await readdir(dirAbs, { withFileTypes: true });
	} catch {
		return { ok: false, path: dirRel, entries: [], isGitRepository: false, error: "Directory not found." };
	}

	// Always drop the engine/runtime dirs before anything else.
	const visibleNames = dirents.map((d) => d.name).filter((name) => !ALWAYS_HIDDEN_NAMES.has(name));

	const relPaths = visibleNames.map((name) => (dirRel ? `${dirRel}/${name}` : name));
	const probe = await probeGitIgnored(root, dirAbs, relPaths);

	const entries: RuntimeFsEntry[] = [];
	for (const name of visibleNames) {
		const rel = dirRel ? `${dirRel}/${name}` : name;
		const gitIgnored = probe.ignored.has(rel);
		if (!showHidden) {
			if (probe.isGitRepository) {
				if (gitIgnored) {
					continue;
				}
			} else if (name.startsWith(".")) {
				// Non-git working tree: hide dotfiles when not showing hidden.
				continue;
			}
		}
		try {
			entries.push(await buildEntry(root, joinNative(dirAbs, name), name, gitIgnored));
		} catch (error) {
			// A racing delete (or a dangling symlink) mid-listing: skip the entry.
			log.debug("skipped unreadable entry", { path: rel, error });
		}
	}

	entries.sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind === "dir" ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});

	return { ok: true, path: dirRel, entries, isGitRepository: probe.isGitRepository };
}

// -----------------------------------------------------------------------------
// listPaths — flat FILE path index for Quick Open (⌘P).
//
// Fast path: one `git ls-files -z --cached --others --exclude-standard` yields
// tracked + untracked-minus-ignored files in a single subprocess (gitignore for
// free). Fallback (non-git tree, or git unavailable/overflowing): a bounded,
// sequential BFS walk that hides dotfiles and stops at the cap — sequential
// readdir (never a recursive fan-out) so a huge tree can't exhaust file handles
// (AGENTS.md: large-workspace EMFILE). `.git`/`.kanban` are excluded at any depth.
// -----------------------------------------------------------------------------

/** True when any path segment is an always-hidden engine dir (`.git`/`.kanban`). */
function isReservedRelPath(rel: string): boolean {
	return rel.split("/").some((segment) => ALWAYS_HIDDEN_NAMES.has(segment));
}

/**
 * Run `git ls-files` for the working tree's non-ignored file paths. Returns the
 * repo-relative POSIX paths (engine dirs filtered out), or `null` when this is
 * not a git repository / git is unavailable / its output overflowed the buffer —
 * in which case the caller falls back to {@link walkFilePaths}.
 */
function runLsFiles(root: string): Promise<string[] | null> {
	return new Promise<string[] | null>((resolvePromise) => {
		const child = execFile(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: LS_FILES_MAX_BUFFER, env: createGitProcessEnv() },
			(error, stdout) => {
				if (error) {
					// Not a git repo (128), git missing, timeout, or maxBuffer overflow:
					// degrade to the bounded walk.
					resolvePromise(null);
					return;
				}
				const paths: string[] = [];
				for (const line of (stdout ?? "").split("\0")) {
					const value = line.replace(/\\/g, "/");
					if (value && !isReservedRelPath(value)) {
						paths.push(value);
					}
				}
				resolvePromise(paths);
			},
		);
		child.on("error", () => resolvePromise(null));
	});
}

/**
 * Bounded, sequential working-tree walk yielding repo-relative POSIX file paths,
 * hiding dotfiles and the engine dirs and never following symlinks. Walks one
 * directory at a time (BFS) and stops as soon as it has `cap + 1` files, so a
 * giant tree neither exhausts file handles nor over-collects: `truncated` is then
 * true and the extra sentinel file is dropped.
 */
async function walkFilePaths(root: string, cap: number): Promise<{ paths: string[]; truncated: boolean }> {
	const hardStop = cap + 1;
	const paths: string[] = [];
	const queue: string[] = [""];
	while (queue.length > 0 && paths.length < hardStop) {
		const dir = queue.shift() as string;
		let dirents: Dirent[];
		try {
			dirents = await readdir(joinNative(root, dir), { withFileTypes: true });
		} catch {
			continue; // A racing delete / unreadable dir: skip it.
		}
		dirents.sort((a, b) => a.name.localeCompare(b.name));
		for (const dirent of dirents) {
			const name = dirent.name;
			if (ALWAYS_HIDDEN_NAMES.has(name) || name.startsWith(".") || dirent.isSymbolicLink()) {
				continue;
			}
			const rel = dir ? `${dir}/${name}` : name;
			if (dirent.isDirectory()) {
				queue.push(rel);
			} else if (dirent.isFile()) {
				paths.push(rel);
				if (paths.length >= hardStop) {
					break;
				}
			}
		}
	}
	return { paths: paths.slice(0, cap), truncated: paths.length > cap };
}

export async function fsListPaths(
	root: string,
	input: RuntimeFsListPathsRequest,
): Promise<RuntimeFsListPathsResponse> {
	const cap = Math.min(Math.max(input.limit ?? FS_LIST_PATHS_DEFAULT_CAP, 1), FS_LIST_PATHS_MAX_CAP);

	const gitPaths = await runLsFiles(root);
	if (gitPaths) {
		const truncated = gitPaths.length > cap;
		return {
			ok: true,
			paths: truncated ? gitPaths.slice(0, cap) : gitPaths,
			truncated,
			isGitRepository: true,
		};
	}

	try {
		const { paths, truncated } = await walkFilePaths(root, cap);
		return { ok: true, paths, truncated, isGitRepository: false };
	} catch (error) {
		log.debug("listPaths walk failed", { error });
		return { ok: false, paths: [], truncated: false, isGitRepository: false, error: "Failed to list files." };
	}
}

// -----------------------------------------------------------------------------
// readFile
// -----------------------------------------------------------------------------

async function sniffBinary(absolute: string): Promise<boolean> {
	try {
		const handle = await readFileBytes(absolute);
		const head = handle.subarray(0, BINARY_SNIFF_BYTES);
		return head.includes(0);
	} catch {
		return false;
	}
}

export async function fsReadFile(root: string, input: RuntimeFsReadFileRequest): Promise<RuntimeFsReadFileResponse> {
	const failure = (error: string): RuntimeFsReadFileResponse => ({
		ok: false,
		path: input.path,
		encoding: "utf8",
		size: 0,
		mtimeMs: 0,
		binary: false,
		tooLarge: false,
		truncated: false,
		error,
	});

	let absolute: string;
	try {
		absolute = resolveWithinRoot(root, input.path);
		await assertRealWithinRoot(root, absolute);
	} catch (error) {
		if (error instanceof OutsideRootError) {
			return failure(error.message);
		}
		return failure("File not found.");
	}

	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(absolute);
	} catch {
		return failure("File not found.");
	}
	if (info.isDirectory()) {
		return failure("Path is a directory.");
	}

	const name = absolute.split(/[\\/]/g).pop() ?? "";
	const mimeType = detectMimeType(name);
	let binary: boolean;
	if (isTextExtensionOrBasename(name)) {
		// Known source/text file — trust the extension over a misclassifying mime db.
		binary = false;
	} else if (mimeType === "application/octet-stream") {
		binary = await sniffBinary(absolute);
	} else {
		binary = classifyFileCategory(mimeType) !== "text";
	}

	const size = info.size;
	const mtimeMs = info.mtimeMs;
	const cap = binary ? FS_PREVIEW_MAX_BYTES : FS_EDIT_MAX_BYTES;
	if (size > cap) {
		return {
			ok: true,
			path: toPosixRelative(root, absolute),
			encoding: binary ? "base64" : "utf8",
			size,
			mtimeMs,
			binary,
			tooLarge: true,
			truncated: false,
		};
	}

	let buffer: Buffer;
	try {
		buffer = await readFileBytes(absolute);
	} catch {
		return failure("File not found.");
	}

	return {
		ok: true,
		path: toPosixRelative(root, absolute),
		encoding: binary ? "base64" : "utf8",
		content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
		size,
		mtimeMs,
		binary,
		tooLarge: false,
		truncated: false,
	};
}

// -----------------------------------------------------------------------------
// downloadEntry — binary-safe raw-byte download (file) / zip bundle (directory).
//
// Distinct from `readFile` (editable text / size-capped preview): this returns
// EXACT on-disk bytes for a browser download. A file → its bytes + detected mime;
// a directory → a base64 zip mirroring the on-disk tree under a `<dir>/` top
// folder. `.git`/`.kanban` and symlinks are always excluded (symlinks are never
// followed, so a link can't smuggle bytes in from outside the root or loop). The
// payload is capped by {@link FS_DOWNLOAD_MAX_BYTES}; over it → `tooLarge`.
// -----------------------------------------------------------------------------

/** Thrown mid-walk when a directory's accumulated bytes exceed the download cap. */
class DownloadTooLargeError extends Error {
	constructor() {
		super("The directory is too large to download.");
		this.name = "DownloadTooLargeError";
	}
}

/**
 * Recursively add a directory's files to `zip` under `prefix` (a trailing-slashed
 * archive path). Skips the always-hidden engine dirs and every symlink, and
 * throws {@link DownloadTooLargeError} once the running total exceeds the cap.
 * Returns the accumulated uncompressed byte count.
 */
async function addDirToZip(dirAbs: string, zip: JSZip, prefix: string, runningTotal: number): Promise<number> {
	let total = runningTotal;
	const dirents = await readdir(dirAbs, { withFileTypes: true });
	for (const dirent of dirents) {
		if (ALWAYS_HIDDEN_NAMES.has(dirent.name) || dirent.isSymbolicLink()) {
			continue;
		}
		const childAbs = joinNative(dirAbs, dirent.name);
		if (dirent.isDirectory()) {
			total = await addDirToZip(childAbs, zip, `${prefix}${dirent.name}/`, total);
		} else if (dirent.isFile()) {
			let fileSize = 0;
			try {
				fileSize = (await stat(childAbs)).size;
			} catch {
				// A racing delete mid-walk: skip the vanished file.
				continue;
			}
			total += fileSize;
			if (total > FS_DOWNLOAD_MAX_BYTES) {
				throw new DownloadTooLargeError();
			}
			try {
				zip.file(`${prefix}${dirent.name}`, await readFileBytes(childAbs));
			} catch {
				// Unreadable/vanished mid-read: drop it, keep the rest of the bundle.
				total -= fileSize;
			}
		}
	}
	return total;
}

export async function fsDownloadEntry(
	root: string,
	input: RuntimeFsDownloadEntryRequest,
): Promise<RuntimeFsDownloadEntryResponse> {
	const failure = (error: string): RuntimeFsDownloadEntryResponse => ({
		ok: false,
		fileName: "",
		mimeType: "application/octet-stream",
		isDirectory: false,
		tooLarge: false,
		error,
	});

	let absolute: string;
	try {
		absolute = resolveWithinRoot(root, input.path);
		await assertRealWithinRoot(root, absolute);
	} catch (error) {
		if (error instanceof OutsideRootError) {
			return failure(error.message);
		}
		return failure("File not found.");
	}

	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(absolute);
	} catch {
		return failure("File not found.");
	}

	// Root resolves to the repo dir itself, so its basename is the repo folder name;
	// the `|| "archive"` only guards a pathological empty basename (e.g. "/").
	const baseName = absolute.split(/[\\/]/g).pop() || "archive";

	if (info.isDirectory()) {
		const zip = new JSZip();
		try {
			await addDirToZip(absolute, zip, `${baseName}/`, 0);
		} catch (error) {
			if (error instanceof DownloadTooLargeError) {
				return { ok: true, fileName: `${baseName}.zip`, mimeType: "application/zip", isDirectory: true, tooLarge: true };
			}
			return failure("Failed to read the directory.");
		}
		const data = await zip.generateAsync({ type: "base64" });
		return { ok: true, fileName: `${baseName}.zip`, mimeType: "application/zip", data, isDirectory: true, tooLarge: false };
	}

	const mimeType = detectMimeType(baseName);
	if (info.size > FS_DOWNLOAD_MAX_BYTES) {
		return { ok: true, fileName: baseName, mimeType, isDirectory: false, tooLarge: true };
	}

	let buffer: Buffer;
	try {
		buffer = await readFileBytes(absolute);
	} catch {
		return failure("File not found.");
	}
	return { ok: true, fileName: baseName, mimeType, data: buffer.toString("base64"), isDirectory: false, tooLarge: false };
}

// -----------------------------------------------------------------------------
// stat
// -----------------------------------------------------------------------------

export async function fsStat(root: string, input: RuntimeFsStatRequest): Promise<RuntimeFsStatResponse> {
	let absolute: string;
	try {
		absolute = resolveWithinRoot(root, input.path);
		await assertRealWithinRoot(root, absolute);
	} catch (error) {
		if (error instanceof OutsideRootError) {
			return { ok: false, entry: null, error: error.message };
		}
		return { ok: true, entry: null };
	}

	try {
		const entry = await buildEntryWithGitignore(root, absolute);
		return { ok: true, entry };
	} catch {
		return { ok: true, entry: null };
	}
}

// -----------------------------------------------------------------------------
// writeFile (P2) — edit + save with optimistic-concurrency (mtime) check.
//
// Runs the same path-safety pipeline as the mutations (reserved-dir guard →
// string sandbox → symlink-real guard) and additionally refuses to touch the
// repository root. The file must already EXIST (this surface edits opened files;
// creation is `createEntry`). When `expectedMtimeMs` is supplied it is compared
// against the current on-disk mtime and a mismatch — or a file that vanished —
// yields `{ ok: false, conflict: true }` WITHOUT writing, so the UI can offer
// overwrite/reload. Omitting `expectedMtimeMs` forces the write.
// -----------------------------------------------------------------------------

export async function fsWriteFile(root: string, input: RuntimeFsWriteFileRequest): Promise<RuntimeFsWriteFileResponse> {
	let absolute: string;
	try {
		assertNotReservedPath(input.path);
		absolute = resolveWithinRoot(root, input.path);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "Invalid path.") };
	}
	if (!toPosixRelative(root, absolute)) {
		return { ok: false, error: "Cannot write to the repository root." };
	}

	// The target must exist and stay within the real root (no symlink escape).
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		await assertRealWithinRoot(root, absolute);
		info = await stat(absolute);
	} catch (error) {
		if (error instanceof OutsideRootError) {
			return { ok: false, error: error.message };
		}
		// The file is gone. When the client had a baseline this is a lost-update
		// race, so surface it as a conflict (offer reload); otherwise a plain miss.
		if (input.expectedMtimeMs !== undefined) {
			return { ok: false, conflict: true, error: "The file no longer exists." };
		}
		return { ok: false, error: "File not found." };
	}
	if (info.isDirectory()) {
		return { ok: false, error: "Path is a directory." };
	}

	// Optimistic concurrency: refuse when the file changed since it was read.
	if (input.expectedMtimeMs !== undefined && info.mtimeMs !== input.expectedMtimeMs) {
		return { ok: false, conflict: true, error: "The file was modified outside the editor." };
	}

	const encoding = input.encoding ?? "utf8";
	const buffer = Buffer.from(input.content, encoding === "base64" ? "base64" : "utf8");
	if (buffer.byteLength > FS_EDIT_MAX_BYTES) {
		return { ok: false, error: "File is too large to save." };
	}

	try {
		await writeFile(absolute, buffer);
	} catch (error) {
		return { ok: false, error: fsSystemErrorMessage(error, "Failed to save the file.") };
	}

	let mtimeMs = 0;
	try {
		mtimeMs = (await stat(absolute)).mtimeMs;
	} catch {
		// The write succeeded; a failing post-stat only costs the fresh baseline.
	}
	return { ok: true, mtimeMs };
}

// -----------------------------------------------------------------------------
// uploadFile — binary-safe write of an uploaded/dragged-in OS file into a dir.
//
// Runs the same path-safety pipeline as the mutations (reserved-dir guard →
// string sandbox → symlink-real guard on the target dir). The target directory
// must already exist. On a same-name collision the behavior follows `onConflict`:
// "error" (default) refuses without writing so the UI can confirm; "overwrite"
// replaces the existing FILE (never a directory, and never a symlink — writing
// through a link could escape the root); "rename" writes to the next free
// "name (n).ext". The decoded payload is capped by {@link FS_UPLOAD_MAX_BYTES}.
// -----------------------------------------------------------------------------

/**
 * Split a bare filename into `[base, ext]` for auto-rename, where `ext` includes
 * its leading dot. A leading-dot dotfile (".env") has no extension: `[".env", ""]`.
 */
function splitNameForRename(name: string): [string, string] {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) {
		return [name, ""];
	}
	return [name.slice(0, dot), name.slice(dot)];
}

/** Find the next free "name (n).ext" in `dirAbs`, or null if none within 1000. */
async function findAvailableName(dirAbs: string, name: string): Promise<string | null> {
	const [base, ext] = splitNameForRename(name);
	for (let n = 1; n <= 1000; n += 1) {
		const candidate = `${base} (${n})${ext}`;
		try {
			await lstat(joinNative(dirAbs, candidate));
		} catch {
			return candidate;
		}
	}
	return null;
}

export async function fsUploadFile(
	root: string,
	input: RuntimeFsUploadFileRequest,
): Promise<RuntimeFsUploadFileResponse> {
	const nameError = validateBareName(input.name);
	if (nameError) {
		return { ok: false, error: nameError };
	}
	const name = input.name.trim();

	let dirAbs: string;
	try {
		assertNotReservedPath(input.dir);
		assertNotReservedPath(name);
		dirAbs = resolveWithinRoot(root, input.dir);
		await assertRealWithinRoot(root, dirAbs);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "Invalid path.") };
	}

	let dirInfo: Awaited<ReturnType<typeof stat>>;
	try {
		dirInfo = await stat(dirAbs);
	} catch {
		return { ok: false, error: "The target directory does not exist." };
	}
	if (!dirInfo.isDirectory()) {
		return { ok: false, error: "The target is not a directory." };
	}

	const buffer = Buffer.from(input.data, "base64");
	if (buffer.byteLength > FS_UPLOAD_MAX_BYTES) {
		return { ok: false, error: "File is too large to upload." };
	}

	let targetAbs = joinNative(dirAbs, name);
	// Symlink-escape guard on the target's parent (the dir must resolve inside root).
	try {
		await assertRealParentWithinRoot(root, targetAbs);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "Invalid path.") };
	}

	const mode = input.onConflict ?? "error";
	let existing: Awaited<ReturnType<typeof lstat>> | null = null;
	try {
		existing = await lstat(targetAbs);
	} catch {
		// Expected: no collision.
	}
	if (existing) {
		if (mode === "error") {
			return { ok: false, conflict: true, error: "An entry with that name already exists." };
		}
		if (mode === "rename") {
			const renamed = await findAvailableName(dirAbs, name);
			if (!renamed) {
				return { ok: false, error: "Could not find an available name." };
			}
			targetAbs = joinNative(dirAbs, renamed);
		} else {
			// overwrite: never replace a directory, and never write through a symlink
			// (that would follow the link and could escape the root).
			if (existing.isDirectory()) {
				return { ok: false, error: "A directory with that name already exists." };
			}
			if (existing.isSymbolicLink()) {
				return { ok: false, error: "Refusing to overwrite a symlink." };
			}
		}
	}

	try {
		await writeFile(targetAbs, buffer);
	} catch (error) {
		return { ok: false, error: fsSystemErrorMessage(error, "Failed to upload the file.") };
	}
	return { ok: true, entry: await buildEntryWithGitignore(root, targetAbs) };
}

// -----------------------------------------------------------------------------
// Mutations (P3): createEntry / rename / move / deleteEntry.
//
// Every mutation re-runs the full path-safety pipeline before any fs write:
// reserved-dir guard (§4.3.4) → string sandbox (no `..`/absolute) → symlink-real
// guard on the target (or its parent, for not-yet-existing targets). Failures
// return `{ ok: false, error }` rather than throwing, so the UI can toast them.
// -----------------------------------------------------------------------------

export async function fsCreateEntry(
	root: string,
	input: RuntimeFsCreateEntryRequest,
): Promise<RuntimeFsEntryMutationResponse> {
	let absolute: string;
	try {
		assertNotReservedPath(input.path);
		absolute = resolveWithinRoot(root, input.path);
		await assertRealParentWithinRoot(root, absolute);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "Invalid path.") };
	}
	if (!toPosixRelative(root, absolute)) {
		return { ok: false, error: "A name is required." };
	}
	try {
		await lstat(absolute);
		return { ok: false, error: "An entry with that name already exists." };
	} catch {
		// Expected: the target must not already exist.
	}
	try {
		if (input.kind === "dir") {
			// Non-recursive: the parent directory must already exist.
			await mkdir(absolute);
		} else {
			await writeFile(absolute, "", { flag: "wx" });
		}
	} catch (error) {
		return { ok: false, error: fsSystemErrorMessage(error, "Failed to create the entry.") };
	}
	return { ok: true, entry: await buildEntryWithGitignore(root, absolute) };
}

export async function fsRename(root: string, input: RuntimeFsRenameRequest): Promise<RuntimeFsEntryMutationResponse> {
	const nameError = validateBareName(input.newName);
	if (nameError) {
		return { ok: false, error: nameError };
	}
	const newName = input.newName.trim();
	let sourceAbs: string;
	try {
		assertNotReservedPath(input.path);
		sourceAbs = resolveWithinRoot(root, input.path);
		await assertRealWithinRoot(root, sourceAbs);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "File not found.") };
	}
	if (!toPosixRelative(root, sourceAbs)) {
		return { ok: false, error: "Cannot rename the repository root." };
	}
	const targetAbs = joinNative(dirnameNative(sourceAbs), newName);
	try {
		await lstat(targetAbs);
		return { ok: false, error: "An entry with that name already exists." };
	} catch {
		// Expected: no existing entry at the new name.
	}
	try {
		await rename(sourceAbs, targetAbs);
	} catch (error) {
		return { ok: false, error: fsSystemErrorMessage(error, "Failed to rename the entry.") };
	}
	return { ok: true, entry: await buildEntryWithGitignore(root, targetAbs) };
}

export async function fsMove(root: string, input: RuntimeFsMoveRequest): Promise<RuntimeFsEntryMutationResponse> {
	let fromAbs: string;
	let toAbs: string;
	try {
		assertNotReservedPath(input.fromPath);
		assertNotReservedPath(input.toPath);
		fromAbs = resolveWithinRoot(root, input.fromPath);
		await assertRealWithinRoot(root, fromAbs);
		toAbs = resolveWithinRoot(root, input.toPath);
		await assertRealParentWithinRoot(root, toAbs);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "File not found.") };
	}
	const fromRel = toPosixRelative(root, fromAbs);
	const toRel = toPosixRelative(root, toAbs);
	if (!fromRel) {
		return { ok: false, error: "Cannot move the repository root." };
	}
	if (!toRel) {
		return { ok: false, error: "Invalid destination." };
	}
	if (toRel === fromRel) {
		return { ok: false, error: "The source and destination are the same." };
	}
	// A directory cannot be moved inside itself or one of its descendants.
	if (toRel.startsWith(`${fromRel}/`)) {
		return { ok: false, error: "Cannot move a directory into itself." };
	}
	try {
		await lstat(toAbs);
		return { ok: false, error: "An entry already exists at the destination." };
	} catch {
		// Expected: the destination must be free.
	}
	try {
		await rename(fromAbs, toAbs);
	} catch (error) {
		return { ok: false, error: fsSystemErrorMessage(error, "Failed to move the entry.") };
	}
	return { ok: true, entry: await buildEntryWithGitignore(root, toAbs) };
}

export async function fsDeleteEntry(
	root: string,
	input: RuntimeFsDeleteEntryRequest,
): Promise<RuntimeFsDeleteEntryResponse> {
	let absolute: string;
	try {
		assertNotReservedPath(input.path);
		absolute = resolveWithinRoot(root, input.path);
		await assertRealWithinRoot(root, absolute);
	} catch (error) {
		return { ok: false, error: mutationErrorMessage(error, "File not found.") };
	}
	if (!toPosixRelative(root, absolute)) {
		return { ok: false, error: "Refusing to delete the repository root." };
	}
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(absolute);
	} catch {
		return { ok: false, error: "File not found." };
	}
	if (info.isDirectory()) {
		if (input.recursive !== true) {
			const contents = await readdir(absolute);
			if (contents.length > 0) {
				return { ok: false, error: "Directory is not empty. Confirm a recursive delete." };
			}
		}
		try {
			await rm(absolute, { recursive: true, force: false });
		} catch (error) {
			return { ok: false, error: fsSystemErrorMessage(error, "Failed to delete the directory.") };
		}
	} else {
		try {
			await rm(absolute, { force: false });
		} catch (error) {
			return { ok: false, error: fsSystemErrorMessage(error, "Failed to delete the file.") };
		}
	}
	return { ok: true };
}

// -----------------------------------------------------------------------------
// Scope-bound API surface consumed by the tRPC router.
// -----------------------------------------------------------------------------

export interface WorkspaceFsApi {
	listDir: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsListDirRequest) => Promise<RuntimeFsListDirResponse>;
	listPaths: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeFsListPathsRequest,
	) => Promise<RuntimeFsListPathsResponse>;
	readFile: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsReadFileRequest) => Promise<RuntimeFsReadFileResponse>;
	downloadEntry: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeFsDownloadEntryRequest,
	) => Promise<RuntimeFsDownloadEntryResponse>;
	writeFile: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeFsWriteFileRequest,
	) => Promise<RuntimeFsWriteFileResponse>;
	uploadFile: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeFsUploadFileRequest,
	) => Promise<RuntimeFsUploadFileResponse>;
	stat: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsStatRequest) => Promise<RuntimeFsStatResponse>;
	createEntry: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeFsCreateEntryRequest,
	) => Promise<RuntimeFsEntryMutationResponse>;
	rename: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsRenameRequest) => Promise<RuntimeFsEntryMutationResponse>;
	move: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsMoveRequest) => Promise<RuntimeFsEntryMutationResponse>;
	deleteEntry: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeFsDeleteEntryRequest,
	) => Promise<RuntimeFsDeleteEntryResponse>;
}

export function createWorkspaceFsApi(): WorkspaceFsApi {
	return {
		listDir: (scope, input) => fsListDir(scope.workspacePath, input),
		listPaths: (scope, input) => fsListPaths(scope.workspacePath, input),
		readFile: (scope, input) => fsReadFile(scope.workspacePath, input),
		downloadEntry: (scope, input) => fsDownloadEntry(scope.workspacePath, input),
		writeFile: (scope, input) => fsWriteFile(scope.workspacePath, input),
		uploadFile: (scope, input) => fsUploadFile(scope.workspacePath, input),
		stat: (scope, input) => fsStat(scope.workspacePath, input),
		createEntry: (scope, input) => fsCreateEntry(scope.workspacePath, input),
		rename: (scope, input) => fsRename(scope.workspacePath, input),
		move: (scope, input) => fsMove(scope.workspacePath, input),
		deleteEntry: (scope, input) => fsDeleteEntry(scope.workspacePath, input),
	};
}

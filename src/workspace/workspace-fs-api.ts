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

import type {
	RuntimeFsCreateEntryRequest,
	RuntimeFsDeleteEntryRequest,
	RuntimeFsDeleteEntryResponse,
	RuntimeFsEntry,
	RuntimeFsEntryMutationResponse,
	RuntimeFsListDirRequest,
	RuntimeFsListDirResponse,
	RuntimeFsMoveRequest,
	RuntimeFsReadFileRequest,
	RuntimeFsReadFileResponse,
	RuntimeFsRenameRequest,
	RuntimeFsStatRequest,
	RuntimeFsStatResponse,
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
// Bytes sniffed from a file's head to decide binary-vs-text when the mime is unknown.
const BINARY_SNIFF_BYTES = 8192;

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
	readFile: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeFsReadFileRequest) => Promise<RuntimeFsReadFileResponse>;
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
		readFile: (scope, input) => fsReadFile(scope.workspacePath, input),
		stat: (scope, input) => fsStat(scope.workspacePath, input),
		createEntry: (scope, input) => fsCreateEntry(scope.workspacePath, input),
		rename: (scope, input) => fsRename(scope.workspacePath, input),
		move: (scope, input) => fsMove(scope.workspacePath, input),
		deleteEntry: (scope, input) => fsDeleteEntry(scope.workspacePath, input),
	};
}

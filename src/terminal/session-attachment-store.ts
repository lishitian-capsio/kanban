import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { safeRandomUUID } from "../core/safe-uuid";
import { createLogger } from "../logging";

const log = createLogger("session-attachment");

/**
 * Cap on a single attachment's decoded bytes. Matches the composer's in-memory
 * image cap so the two upload channels feel the same to the user.
 */
export const TASK_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Maximum number of files a single scope (thread/task) may accumulate. */
export const ATTACHMENT_SCOPE_MAX_FILES = 20;

/** Cap on the combined bytes of all attachments in a single scope. */
export const ATTACHMENT_SCOPE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Repo-relative location, inside the cwd, where attachments live. */
const ATTACHMENTS_DIR_SEGMENTS = [".kanban", "attachments"] as const;

/** Bound the extension so a crafted name can't blow up the filename. */
const MAX_EXTENSION_LENGTH = 16;

/** Bound the human-readable base name embedded in the stored filename. */
const MAX_BASE_NAME_LENGTH = 64;

/** Length (hex chars) of the uniqueness suffix appended to every stored name. */
const UNIQUE_SUFFIX_LENGTH = 8;

/**
 * A scope pins attachments to a single owner directory. `root` is a trusted,
 * server-resolved path (a task worktree or the workspace repo root); `scopeId`
 * is the owner id (a task id or a home-thread id). The final directory is
 * `<root>/.kanban/attachments/<scopeId>/`, and `scopeId` is validated to be a
 * single safe path segment so it can never escape the attachments directory.
 */
export interface AttachmentScope {
	root: string;
	scopeId: string;
}

export interface WriteScopeAttachmentInput {
	scope: AttachmentScope;
	/**
	 * The original filename. Its sanitized base name is embedded in the stored
	 * filename (so an agent/user can recognize it) and its extension is derived;
	 * neither can influence the destination directory — a UUID suffix guarantees
	 * uniqueness and the scope directory is a fixed, validated join.
	 */
	name: string;
	/** Base64-encoded file bytes. */
	data: string;
	/** Override the default {@link TASK_ATTACHMENT_MAX_BYTES} single-file cap. */
	maxBytes?: number;
}

export type WriteScopeAttachmentResult = { ok: true; path: string; fileName: string } | { ok: false; error: string };

/** One stored attachment, as surfaced to management/list callers. */
export interface ScopeAttachmentEntry {
	/** Stored filename, e.g. `report-a1b2c3d4.pdf`. Embeds the sanitized original name. */
	fileName: string;
	/** Absolute on-disk path. */
	path: string;
	/** Size in bytes. */
	size: number;
	/** Last-modified time (ms since epoch), for display/sorting. */
	mtimeMs: number;
}

/** All attachments in one scope directory, for the grouped management surface. */
export interface AttachmentScopeListing {
	/** The scope directory name (a home-thread id or a task id). */
	scopeId: string;
	/** The attachments in this scope, newest first. */
	entries: ScopeAttachmentEntry[];
}

/**
 * A scope id must be a single, safe path segment: only `[A-Za-z0-9._-]`, no path
 * separators, no `.`/`..`, length-bounded. This is what keeps `<root>/.kanban/
 * attachments/<scopeId>/` from ever escaping the attachments directory. Task ids
 * and home-thread ids (UUIDs / `default`) all satisfy this.
 */
export function isValidAttachmentScopeId(scopeId: string): boolean {
	if (scopeId.length === 0 || scopeId.length > 128) {
		return false;
	}
	if (scopeId === "." || scopeId === "..") {
		return false;
	}
	return /^[A-Za-z0-9._-]+$/.test(scopeId);
}

/**
 * Derive a safe file extension from an arbitrary filename: the substring after
 * the LAST dot, lowercased, reduced to `[a-z0-9]` and length-capped. Returns ""
 * when there is no usable extension. Stripping every non-alphanumeric character
 * means a crafted name (`evil.pn/../g`) can never smuggle a separator or `..`.
 */
export function sanitizeAttachmentExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot < 0 || dot === name.length - 1) {
		return "";
	}
	return name
		.slice(dot + 1)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, MAX_EXTENSION_LENGTH);
}

/**
 * Derive a human-readable, filesystem-safe base name from an arbitrary filename
 * (excluding its extension). Drops any directory portion, strips control and
 * shell-hazardous characters, collapses whitespace to `-`, and length-caps.
 * Returns `"file"` when nothing usable remains, so the stored name is always
 * meaningful *and* safe — it can never contain a separator, `..`, or a leading
 * dot, so it can never influence the destination path.
 */
export function sanitizeAttachmentBaseName(name: string): string {
	// Take only the segment after the last path separator, then drop the extension.
	const afterSep = name.replace(/^.*[\\/]/, "");
	const dot = afterSep.lastIndexOf(".");
	const stem = dot > 0 ? afterSep.slice(0, dot) : afterSep;
	// Anything outside the allowlist (spaces, control chars, shell-hazardous
	// punctuation) collapses to a single `-`; leading/trailing `.`/`-` are then
	// trimmed so the name can never start with a dot or contain a separator.
	const cleaned = stem
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[.-]+/, "")
		.replace(/[.-]+$/, "")
		.slice(0, MAX_BASE_NAME_LENGTH);
	return cleaned.length > 0 ? cleaned : "file";
}

/**
 * Build the stored filename: `<sanitized-base>-<shortuuid>[.<ext>]`. The short
 * uuid guarantees uniqueness within the scope while the base keeps it readable.
 */
export function buildAttachmentFileName(name: string): string {
	const base = sanitizeAttachmentBaseName(name);
	const extension = sanitizeAttachmentExtension(name);
	const unique = safeRandomUUID().replace(/-/g, "").slice(0, UNIQUE_SUFFIX_LENGTH);
	const stem = `${base}-${unique}`;
	return extension ? `${stem}.${extension}` : stem;
}

/**
 * Resolve a scope's absolute attachments directory, throwing if the scope id is
 * unsafe. Every read/write/delete routes through here so the traversal guard is
 * enforced in exactly one place.
 */
export function resolveAttachmentScopeDir(scope: AttachmentScope): string {
	if (!isValidAttachmentScopeId(scope.scopeId)) {
		throw new Error(`Invalid attachment scope id: ${JSON.stringify(scope.scopeId)}`);
	}
	return join(scope.root, ...ATTACHMENTS_DIR_SEGMENTS, scope.scopeId);
}

/** List the attachments in a scope (empty when the directory doesn't exist). */
export async function listScopeAttachments(scope: AttachmentScope): Promise<ScopeAttachmentEntry[]> {
	const directory = resolveAttachmentScopeDir(scope);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}
	const entries: ScopeAttachmentEntry[] = [];
	for (const fileName of names) {
		const path = join(directory, fileName);
		try {
			const info = await stat(path);
			if (info.isFile()) {
				entries.push({ fileName, path, size: info.size, mtimeMs: info.mtimeMs });
			}
		} catch {
			// A file that vanished between readdir and stat is simply skipped.
		}
	}
	return entries;
}

/**
 * List every attachment scope under `<root>/.kanban/attachments/`, each with its
 * files (newest first). Skips subdirectory names that are not safe scope ids (so a
 * hand-created stray directory can never widen the surface) and returns an empty
 * array when the attachments directory does not exist. This backs the grouped
 * "Attachments" management surface — the ONLY read window opened into `.kanban`.
 */
export async function listAllAttachmentScopes(root: string): Promise<AttachmentScopeListing[]> {
	const attachmentsRoot = join(root, ...ATTACHMENTS_DIR_SEGMENTS);
	let dirents: Dirent[];
	try {
		dirents = await readdir(attachmentsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const listings: AttachmentScopeListing[] = [];
	for (const dirent of dirents) {
		if (!dirent.isDirectory() || !isValidAttachmentScopeId(dirent.name)) {
			continue;
		}
		const entries = await listScopeAttachments({ root, scopeId: dirent.name });
		if (entries.length === 0) {
			continue;
		}
		entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
		listings.push({ scopeId: dirent.name, entries });
	}
	return listings;
}

/**
 * Delete a SINGLE attachment file from `<root>/.kanban/attachments/<scopeId>/`.
 * This is the deliberately-restricted deletion path for the management surface —
 * NOT the generic `fsDeleteEntry`, which refuses any `.kanban` path. `fileName`
 * must be a bare name (no separators, no `.`/`..`), so it can only ever name a
 * direct child of the validated scope directory; anything else is refused without
 * touching disk. A missing file resolves `{ ok: true }` (idempotent). To remove an
 * entire scope use {@link deleteAttachmentScope}.
 */
export async function deleteScopeAttachmentFile(
	scope: AttachmentScope,
	fileName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	let directory: string;
	try {
		directory = resolveAttachmentScopeDir(scope);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	// A file name must be a single safe path segment: no separators (which could
	// point outside the scope dir) and not `.`/`..`. The stored-name allowlist is a
	// superset of what we ever write, so a legitimate attachment always passes.
	if (fileName.length === 0 || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) {
		return { ok: false, error: "Invalid attachment file name." };
	}
	const absolutePath = join(directory, fileName);
	try {
		const info = await stat(absolutePath);
		if (!info.isFile()) {
			return { ok: false, error: "Not an attachment file." };
		}
	} catch {
		// Already gone: treat as a successful delete so the UI can prune it.
		return { ok: true };
	}
	try {
		await rm(absolutePath, { force: true });
		return { ok: true };
	} catch (error) {
		log.warn("failed to delete scope attachment file", { error, scopeId: scope.scopeId, fileName });
		return { ok: false, error: "Failed to delete the attachment." };
	}
}

/**
 * Write an uploaded/pasted attachment into `<root>/.kanban/attachments/<scopeId>/`
 * under a `<sanitized-base>-<shortuuid>.<ext>` filename. The directory is
 * machine-local (gitignored via the repo's `/.kanban/*` rule) and is cleaned up
 * when its owning scope (task worktree / home thread) is removed.
 *
 * Enforces three caps: the single-file byte cap, the per-scope file count, and
 * the per-scope total bytes. Path safety: the destination is a fixed join of the
 * trusted `root`, a constant subdir, the validated `scopeId`, and a generated
 * basename — the caller's `name` contributes only a sanitized base + extension,
 * never a path segment, so there is no way to escape the attachments directory.
 */
export async function writeScopeAttachment(input: WriteScopeAttachmentInput): Promise<WriteScopeAttachmentResult> {
	const maxBytes = input.maxBytes ?? TASK_ATTACHMENT_MAX_BYTES;
	const buffer = Buffer.from(input.data, "base64");
	if (buffer.byteLength === 0) {
		return { ok: false, error: "The attachment is empty." };
	}
	if (buffer.byteLength > maxBytes) {
		const limitMb = Math.round(maxBytes / (1024 * 1024));
		return { ok: false, error: `The attachment exceeds the ${limitMb} MB limit.` };
	}

	let directory: string;
	try {
		directory = resolveAttachmentScopeDir(input.scope);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	// Enforce per-scope caps against what is already on disk.
	const existing = await listScopeAttachments(input.scope);
	if (existing.length >= ATTACHMENT_SCOPE_MAX_FILES) {
		return { ok: false, error: `This scope already has the maximum of ${ATTACHMENT_SCOPE_MAX_FILES} attachments.` };
	}
	const existingBytes = existing.reduce((sum, entry) => sum + entry.size, 0);
	if (existingBytes + buffer.byteLength > ATTACHMENT_SCOPE_MAX_TOTAL_BYTES) {
		const limitMb = Math.round(ATTACHMENT_SCOPE_MAX_TOTAL_BYTES / (1024 * 1024));
		return {
			ok: false,
			error: `Adding this file would exceed the ${limitMb} MB total attachment limit for this scope.`,
		};
	}

	const fileName = buildAttachmentFileName(input.name);
	const absolutePath = join(directory, fileName);
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(absolutePath, buffer);
		return { ok: true, path: absolutePath, fileName };
	} catch (error) {
		log.error("failed to write scope attachment", { error, scopeId: input.scope.scopeId });
		return { ok: false, error: "Failed to save the attachment." };
	}
}

/**
 * Delete a scope's entire attachments directory. Used when a home thread is
 * closed (hard close) and when a create dialog is cancelled without submitting,
 * so an unclaimed upload never leaks. A missing directory is a no-op.
 */
export async function deleteAttachmentScope(scope: AttachmentScope): Promise<void> {
	const directory = resolveAttachmentScopeDir(scope);
	try {
		await rm(directory, { recursive: true, force: true });
	} catch (error) {
		log.warn("failed to delete attachment scope", { error, scopeId: scope.scopeId });
	}
}

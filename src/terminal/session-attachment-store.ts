import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { safeRandomUUID } from "../core/safe-uuid";
import { createLogger } from "../logging";

const log = createLogger("session-attachment");

/**
 * Cap on a single attachment's decoded bytes. Matches the composer's in-memory
 * image cap so the two upload channels feel the same to the user.
 */
export const TASK_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Repo-relative location, inside the task worktree, where attachments land. */
const ATTACHMENTS_DIR_SEGMENTS = [".kanban", "attachments"] as const;

/** Bound the extension so a crafted name can't blow up the filename. */
const MAX_EXTENSION_LENGTH = 16;

export interface WriteTaskAttachmentInput {
	/** The task worktree root (the CLI agent's cwd) — a trusted, server-resolved path. */
	worktreePath: string;
	/**
	 * The original filename. ONLY its extension is used (sanitized to `[a-z0-9]`);
	 * the stored name is always a fresh UUID, so a caller-supplied path can never
	 * influence where the file is written.
	 */
	name: string;
	/** Base64-encoded file bytes. */
	data: string;
	/** Override the default {@link TASK_ATTACHMENT_MAX_BYTES} cap. */
	maxBytes?: number;
}

export type WriteTaskAttachmentResult = { ok: true; path: string } | { ok: false; error: string };

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
 * Write an uploaded/pasted attachment into `<worktreePath>/.kanban/attachments/`
 * under a fresh UUID filename. The directory is machine-local (gitignored via the
 * repo's `/.kanban/*` rule) and is cleaned up when the task worktree is deleted.
 *
 * Path safety: the destination is a fixed join of the trusted `worktreePath` with
 * a constant subdir and a UUID basename — the caller's `name` contributes only a
 * sanitized extension, never a path segment. There is no way to escape the
 * attachments directory.
 */
export async function writeTaskAttachment(input: WriteTaskAttachmentInput): Promise<WriteTaskAttachmentResult> {
	const maxBytes = input.maxBytes ?? TASK_ATTACHMENT_MAX_BYTES;
	const buffer = Buffer.from(input.data, "base64");
	if (buffer.byteLength === 0) {
		return { ok: false, error: "The attachment is empty." };
	}
	if (buffer.byteLength > maxBytes) {
		const limitMb = Math.round(maxBytes / (1024 * 1024));
		return { ok: false, error: `The attachment exceeds the ${limitMb} MB limit.` };
	}

	const extension = sanitizeAttachmentExtension(input.name);
	const fileName = extension ? `${safeRandomUUID()}.${extension}` : safeRandomUUID();
	const directory = join(input.worktreePath, ...ATTACHMENTS_DIR_SEGMENTS);
	const absolutePath = join(directory, fileName);

	try {
		await mkdir(directory, { recursive: true });
		await writeFile(absolutePath, buffer);
		return { ok: true, path: absolutePath };
	} catch (error) {
		log.error("failed to write task session attachment", { error, worktreePath: input.worktreePath });
		return { ok: false, error: "Failed to save the attachment." };
	}
}

import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { RuntimeArtifactContentResponse } from "../core/api-contract";
import { detectMimeType } from "../files/file-mime";
import { resolveArtifactPreviewKind } from "./artifact-detection";

// Text payloads are capped so a runaway file can't blow up the websocket frame;
// binary payloads (base64 for inline preview / download) get a larger cap.
const MAX_TEXT_CHARS = 1_000_000;
const MAX_BINARY_BYTES = 10_000_000;

/** Thrown when a requested artifact path would resolve outside the worktree. */
export class ArtifactPathEscapeError extends Error {
	constructor(path: string) {
		super(`Artifact path escapes the task worktree: ${path}`);
		this.name = "ArtifactPathEscapeError";
	}
}

/**
 * Resolve a worktree-relative artifact path to an absolute path, rejecting any
 * path that escapes the worktree root (absolute paths, `..` traversal, …).
 */
export function resolveArtifactPathWithinRoot(rootDir: string, relativePath: string): string {
	const root = resolve(rootDir);
	const target = resolve(root, relativePath);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new ArtifactPathEscapeError(relativePath);
	}
	return target;
}

/**
 * Read a single artifact's current content from the task worktree. Text-like
 * kinds return `text`; image / binary kinds return base64 `data` for inline
 * preview or download. Nothing is cached or persisted — the file is read live
 * by relative path each time, so renames/deletes surface naturally as errors.
 */
export async function readArtifactContent(
	rootDir: string,
	relativePath: string,
): Promise<RuntimeArtifactContentResponse> {
	const previewKind = resolveArtifactPreviewKind(relativePath) ?? "binary";
	const absolutePath = resolveArtifactPathWithinRoot(rootDir, relativePath);
	const fileStat = await stat(absolutePath);
	const size = fileStat.size;
	const mimeType = detectMimeType(relativePath);

	if (previewKind === "markdown" || previewKind === "text" || previewKind === "json") {
		const raw = await readFile(absolutePath, "utf8");
		const truncated = raw.length > MAX_TEXT_CHARS;
		return {
			path: relativePath,
			previewKind,
			text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
			data: null,
			mimeType,
			size,
			truncated,
		};
	}

	if (size > MAX_BINARY_BYTES) {
		return {
			path: relativePath,
			previewKind,
			text: null,
			data: null,
			mimeType,
			size,
			truncated: true,
		};
	}

	const bytes = await readFile(absolutePath);
	return {
		path: relativePath,
		previewKind,
		text: null,
		data: bytes.toString("base64"),
		mimeType,
		size,
		truncated: false,
	};
}

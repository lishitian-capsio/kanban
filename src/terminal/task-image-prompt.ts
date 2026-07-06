import { extname } from "node:path";

import type { RuntimeTaskImage } from "../core/api-contract";
import { createLogger } from "../logging";
import { type AttachmentScope, writeScopeAttachment } from "./session-attachment-store";

const log = createLogger("task-image-prompt");

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/webp": ".webp",
};

/**
 * Derive an original-style filename for a composer image so the scope attachment
 * store can embed a readable base name and a correct extension. Claude (and other
 * CLI agents) rely on the file extension to recognize the image type, so when the
 * pasted image has no name/extension we synthesize one from its MIME type.
 */
function resolveTaskImageName(image: RuntimeTaskImage, index: number): string {
	const mimeExtension = IMAGE_EXTENSION_BY_MIME_TYPE[image.mimeType.toLowerCase()] ?? "";
	const displayName = image.name?.trim();
	if (displayName) {
		return extname(displayName) ? displayName : `${displayName}${mimeExtension}`;
	}
	return `image-${index + 1}${mimeExtension}`;
}

function buildTaskPromptWithImagePaths(
	prompt: string,
	imageFileEntries: Array<{ path: string; name?: string }>,
): string {
	const lines = [
		"Attached reference images:",
		...imageFileEntries.map((entry, index) => {
			const displaySuffix = entry.name?.trim() ? ` (${entry.name.trim()})` : "";
			return `${index + 1}. ${entry.path}${displaySuffix}`;
		}),
	];
	const trimmedPrompt = prompt.trim();
	if (!trimmedPrompt) {
		return lines.join("\n");
	}
	return [...lines, "", "Task:", trimmedPrompt].join("\n");
}

/**
 * Materialize a CLI/terminal agent's kickoff images into the session's scope
 * attachment directory (`<cwd>/.kanban/attachments/<scopeId>/`) and rewrite the
 * prompt to reference them by absolute path. This shares the exact same on-disk
 * mechanism, path safety, size caps, and lifecycle cleanup as file attachments
 * (see {@link writeScopeAttachment}), so kickoff images are cleaned up with their
 * owning scope (task worktree delete / home thread close) instead of leaking as
 * `/tmp` files. Images that fail to persist (e.g. scope caps hit) are skipped and
 * logged rather than aborting the launch. pi keeps its own base64-in-message path
 * and never routes through here.
 */
export async function prepareTaskPromptWithImages(input: {
	prompt: string;
	images?: RuntimeTaskImage[];
	scope: AttachmentScope;
}): Promise<string> {
	const images = input.images?.filter((image) => image.data.trim().length > 0) ?? [];
	if (images.length === 0) {
		return input.prompt;
	}

	const imageFileEntries: Array<{ path: string; name?: string }> = [];
	// Sequential: writeScopeAttachment enforces per-scope caps against on-disk
	// state, so concurrent writes could race the count/byte check.
	for (const [index, image] of images.entries()) {
		const result = await writeScopeAttachment({
			scope: input.scope,
			name: resolveTaskImageName(image, index),
			data: image.data,
		});
		if (result.ok) {
			imageFileEntries.push({ path: result.path, name: image.name?.trim() || undefined });
		} else {
			log.warn("failed to persist task image attachment", {
				scopeId: input.scope.scopeId,
				error: result.error,
			});
		}
	}

	if (imageFileEntries.length === 0) {
		return input.prompt;
	}
	return buildTaskPromptWithImagePaths(input.prompt, imageFileEntries);
}

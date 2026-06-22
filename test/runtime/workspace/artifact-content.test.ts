import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ArtifactPathEscapeError,
	readArtifactContent,
	resolveArtifactPathWithinRoot,
} from "../../../src/workspace/artifact-content";

describe("resolveArtifactPathWithinRoot", () => {
	it("resolves relative paths inside the root", () => {
		const resolved = resolveArtifactPathWithinRoot("/repo/worktree", "docs/plan/a.md");
		expect(resolved).toBe("/repo/worktree/docs/plan/a.md");
	});

	it("rejects parent-traversal and absolute escapes", () => {
		expect(() => resolveArtifactPathWithinRoot("/repo/worktree", "../secret.md")).toThrow(ArtifactPathEscapeError);
		expect(() => resolveArtifactPathWithinRoot("/repo/worktree", "/etc/passwd")).toThrow(ArtifactPathEscapeError);
	});
});

describe("readArtifactContent", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "artifact-content-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads markdown as text", async () => {
		await writeFile(join(root, "note.md"), "# Hello\n");
		const result = await readArtifactContent(root, "note.md");
		expect(result.previewKind).toBe("markdown");
		expect(result.text).toBe("# Hello\n");
		expect(result.data).toBeNull();
		expect(result.truncated).toBe(false);
	});

	it("reads images as base64 with a mime type", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		await writeFile(join(root, "pic.png"), bytes);
		const result = await readArtifactContent(root, "pic.png");
		expect(result.previewKind).toBe("image");
		expect(result.data).toBe(bytes.toString("base64"));
		expect(result.text).toBeNull();
		expect(result.mimeType).toBe("image/png");
	});

	it("rejects paths escaping the worktree", async () => {
		await expect(readArtifactContent(root, "../escape.md")).rejects.toBeInstanceOf(ArtifactPathEscapeError);
	});
});

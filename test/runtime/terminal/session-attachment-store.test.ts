import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	sanitizeAttachmentExtension,
	TASK_ATTACHMENT_MAX_BYTES,
	writeTaskAttachment,
} from "../../../src/terminal/session-attachment-store";

const ATTACHMENTS_SUBDIR = join(".kanban", "attachments");

describe("sanitizeAttachmentExtension", () => {
	it("keeps a normal lowercased extension", () => {
		expect(sanitizeAttachmentExtension("photo.PNG")).toBe("png");
	});

	it("returns empty for a name with no extension", () => {
		expect(sanitizeAttachmentExtension("Dockerfile")).toBe("");
	});

	it("returns empty for a trailing dot", () => {
		expect(sanitizeAttachmentExtension("weird.")).toBe("");
	});

	it("strips non-alphanumeric characters from the extension", () => {
		// A crafted name must never smuggle a separator/dots into the ext; only the
		// segment after the LAST dot is considered and it is reduced to [a-z0-9].
		expect(sanitizeAttachmentExtension("shot.p!n@g")).toBe("png");
		expect(sanitizeAttachmentExtension("evil.pn/../g")).toBe("g");
		expect(sanitizeAttachmentExtension("x.tar.gz")).toBe("gz");
	});

	it("caps an absurdly long extension", () => {
		const ext = sanitizeAttachmentExtension(`f.${"a".repeat(100)}`);
		expect(ext.length).toBeLessThanOrEqual(16);
	});
});

describe("writeTaskAttachment", () => {
	let worktree: string;

	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "kanban-attachment-"));
	});

	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("writes the bytes into <worktree>/.kanban/attachments with a uuid + sanitized extension", async () => {
		const payload = Buffer.from("hello world", "utf8");
		const result = await writeTaskAttachment({
			worktreePath: worktree,
			name: "note.png",
			data: payload.toString("base64"),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const dir = join(worktree, ATTACHMENTS_SUBDIR);
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const [fileName] = files;
		// uuid basename + ".png"; NEVER the caller-supplied "note".
		expect(fileName).toMatch(/^[0-9a-f-]{36}\.png$/);
		expect(result.path).toBe(join(dir, fileName as string));
		expect(readFileSync(result.path).equals(payload)).toBe(true);
	});

	it("never uses the caller-supplied name for the path (traversal is neutralized)", async () => {
		const result = await writeTaskAttachment({
			worktreePath: worktree,
			name: "../../../../etc/passwd.png",
			data: Buffer.from("x").toString("base64"),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		// The written path stays inside the attachments dir regardless of the name.
		expect(result.path.startsWith(join(worktree, ATTACHMENTS_SUBDIR))).toBe(true);
		expect(readdirSync(join(worktree, ATTACHMENTS_SUBDIR))).toHaveLength(1);
	});

	it("writes an extensionless file when the name has no usable extension", async () => {
		const result = await writeTaskAttachment({
			worktreePath: worktree,
			name: "clipboard",
			data: Buffer.from("x").toString("base64"),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.path).toMatch(/[0-9a-f-]{36}$/);
	});

	it("rejects an empty payload", async () => {
		const result = await writeTaskAttachment({ worktreePath: worktree, name: "a.png", data: "" });
		expect(result.ok).toBe(false);
	});

	it("rejects a payload over the size cap", async () => {
		const oversized = Buffer.alloc(TASK_ATTACHMENT_MAX_BYTES + 1, 0);
		const result = await writeTaskAttachment({
			worktreePath: worktree,
			name: "big.bin",
			data: oversized.toString("base64"),
		});
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error).toMatch(/limit/i);
		// Nothing was written.
		expect(readdirSync(worktree)).not.toContain(".kanban");
	});

	it("honors a custom maxBytes", async () => {
		const result = await writeTaskAttachment({
			worktreePath: worktree,
			name: "a.txt",
			data: Buffer.alloc(10).toString("base64"),
			maxBytes: 4,
		});
		expect(result.ok).toBe(false);
	});
});

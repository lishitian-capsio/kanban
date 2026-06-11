import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileLibraryStore } from "../../../src/files/file-library-store";

let repoPath: string;
let store: FileLibraryStore;

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-files-store-"));
	store = new FileLibraryStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("FileLibraryStore.add", () => {
	it("stores bytes, classifies the file, and records a manifest entry", async () => {
		const bytes = Buffer.from("hello world");
		const item = await store.add({ name: "notes.txt", bytes });

		expect(item).toMatchObject({
			name: "notes.txt",
			mime: "text/plain",
			category: "text",
			size: bytes.byteLength,
		});
		expect(item.id).toMatch(/^[a-z0-9]+$/);
		expect(item.addedAt).toBeGreaterThan(0);

		const listed = await store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe(item.id);
	});

	it("infers the mime category from the extension for binaries", async () => {
		const item = await store.add({ name: "diagram.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
		expect(item.mime).toBe("image/png");
		expect(item.category).toBe("image");
	});

	it("honors an explicit mime override", async () => {
		const item = await store.add({ name: "blob.bin", bytes: Buffer.from([0x00]), mime: "application/pdf" });
		expect(item.mime).toBe("application/pdf");
		expect(item.category).toBe("document");
	});

	it("uses only the basename and rejects empty names", async () => {
		const item = await store.add({ name: "some/nested/path/photo.png", bytes: Buffer.from([1]) });
		expect(item.name).toBe("photo.png");

		await expect(store.add({ name: "   ", bytes: Buffer.from([1]) })).rejects.toThrow(/name/i);
	});

	it("assigns unique ids across multiple files", async () => {
		const a = await store.add({ name: "a.txt", bytes: Buffer.from("a") });
		const b = await store.add({ name: "b.txt", bytes: Buffer.from("b") });
		expect(a.id).not.toBe(b.id);
		expect(await store.list()).toHaveLength(2);
	});
});

describe("FileLibraryStore.get", () => {
	it("returns the manifest entry by id and null when missing", async () => {
		const item = await store.add({ name: "a.txt", bytes: Buffer.from("a") });
		expect(await store.get(item.id)).toMatchObject({ id: item.id, name: "a.txt" });
		expect(await store.get("nope")).toBeNull();
	});
});

describe("FileLibraryStore.getBytes", () => {
	it("returns the stored content as a buffer and base64", async () => {
		const bytes = Buffer.from("vision content");
		const item = await store.add({ name: "img.png", bytes, mime: "image/png" });

		const result = await store.getBytes(item.id);
		expect(result).not.toBeNull();
		expect(result?.bytes.equals(bytes)).toBe(true);
		expect(result?.data).toBe(bytes.toString("base64"));
		expect(result?.mimeType).toBe("image/png");
	});

	it("returns null for an unknown id", async () => {
		expect(await store.getBytes("nope")).toBeNull();
	});
});

describe("FileLibraryStore.getPath", () => {
	it("returns an absolute path that exists and a stable repo-relative path", async () => {
		const item = await store.add({ name: "photo.png", bytes: Buffer.from([1, 2, 3]) });
		const result = await store.getPath(item.id);

		expect(result).not.toBeNull();
		expect(isAbsolute(result?.absolutePath ?? "")).toBe(true);
		expect(result?.relativePath).toBe(join(".kanban", "files", "blobs", item.id, "photo.png"));
		await expect(stat(result?.absolutePath ?? "")).resolves.toBeTruthy();
	});

	it("returns null for an unknown id", async () => {
		expect(await store.getPath("nope")).toBeNull();
	});
});

describe("FileLibraryStore.rename", () => {
	it("renames the manifest entry and moves the stored blob", async () => {
		const item = await store.add({ name: "old.txt", bytes: Buffer.from("x") });
		const renamed = await store.rename(item.id, "new.txt");

		expect(renamed.name).toBe("new.txt");
		expect((await store.get(item.id))?.name).toBe("new.txt");

		const path = await store.getPath(item.id);
		expect(path?.relativePath.endsWith("new.txt")).toBe(true);
		await expect(stat(path?.absolutePath ?? "")).resolves.toBeTruthy();
	});

	it("throws when the id does not exist", async () => {
		await expect(store.rename("nope", "x.txt")).rejects.toThrow(/not found/i);
	});
});

describe("FileLibraryStore.remove", () => {
	it("deletes the manifest entry and the stored blob", async () => {
		const item = await store.add({ name: "a.txt", bytes: Buffer.from("a") });
		const path = await store.getPath(item.id);

		expect(await store.remove(item.id)).toBe(true);
		expect(await store.get(item.id)).toBeNull();
		expect(await store.list()).toHaveLength(0);
		await expect(stat(path?.absolutePath ?? "")).rejects.toThrow();
	});

	it("returns false when removing an unknown id", async () => {
		expect(await store.remove("nope")).toBe(false);
	});
});

describe("FileLibraryStore git configuration", () => {
	it("writes a .gitattributes that routes blob content through Git LFS", async () => {
		await store.add({ name: "a.png", bytes: Buffer.from([1]) });
		const gitattributes = await readFile(join(repoPath, ".kanban", "files", ".gitattributes"), "utf8");
		expect(gitattributes).toContain("blobs/** filter=lfs diff=lfs merge=lfs -text");
	});

	it("keeps the manifest out of LFS so it stays diffable", async () => {
		await store.add({ name: "a.png", bytes: Buffer.from([1]) });
		const gitattributes = await readFile(join(repoPath, ".kanban", "files", ".gitattributes"), "utf8");
		expect(gitattributes).toContain("files.json -text");
	});
});

describe("FileLibraryStore persistence", () => {
	it("reflects entries written by another store instance over the same repo", async () => {
		const item = await store.add({ name: "a.txt", bytes: Buffer.from("a") });
		const other = new FileLibraryStore(repoPath);
		expect(await other.get(item.id)).toMatchObject({ id: item.id, name: "a.txt" });
	});
});

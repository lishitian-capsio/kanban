import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseVaultDocument, serializeVaultDocument } from "../../../src/vault/vault-document";
import { VaultDocumentStore } from "../../../src/vault/vault-document-store";
import { buildVaultZipBase64 } from "../../../src/vault/vault-export";
import { getVaultTypesDir } from "../../../src/vault/vault-paths";
import { seedVaultTypeDefinitions } from "../../../src/vault/vault-type-registry";

let repoPath: string;
let store: VaultDocumentStore;

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-vault-export-"));
	await seedVaultTypeDefinitions(getVaultTypesDir(repoPath));
	store = new VaultDocumentStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("VaultDocumentStore.exportDocument", () => {
	it("returns the raw on-disk markdown bytes and the .md filename", async () => {
		const created = await store.create({
			type: "requirement",
			title: "Rate-limit login",
			body: "the body",
			frontmatter: { priority: "high" },
		});

		const onDisk = await readFile(join(repoPath, created.relativePath), "utf8");
		const exported = await store.exportDocument(created.id);

		expect(exported).not.toBeNull();
		expect(exported?.fileName).toBe(`rate-limit-login-${created.id}.md`);
		// Byte-identical to what git tracks — never a frontend reconstruction.
		expect(exported?.content).toBe(onDisk);
	});

	it("exports content identical to the canonical serializer (no drift)", async () => {
		const created = await store.create({ type: "requirement", title: "Stable" });
		const exported = await store.exportDocument(created.id);
		const canonical = serializeVaultDocument(parseVaultDocument(exported?.content ?? ""));
		expect(exported?.content).toBe(canonical);
	});

	it("returns null for an unknown id", async () => {
		expect(await store.exportDocument("nope")).toBeNull();
	});
});

describe("VaultDocumentStore.exportDocuments", () => {
	it("tags each document with its archive-relative path under docs/<type>/", async () => {
		const req = await store.create({ type: "requirement", title: "A requirement" });
		const note = await store.create({ type: "note", title: "A note" });

		const entries = await store.exportDocuments([req.id, note.id]);

		expect(entries.map((entry) => entry.entryPath)).toEqual([
			join("docs", "requirement", `a-requirement-${req.id}.md`),
			join("docs", "note", `a-note-${note.id}.md`),
		]);
		const reqOnDisk = await readFile(join(repoPath, req.relativePath), "utf8");
		expect(entries[0]?.content).toBe(reqOnDisk);
	});

	it("preserves caller order and skips unknown ids", async () => {
		const a = await store.create({ type: "requirement", title: "A" });
		const b = await store.create({ type: "requirement", title: "B" });

		const entries = await store.exportDocuments([b.id, "missing", a.id]);

		expect(entries).toHaveLength(2);
		expect(entries[0]?.entryPath).toContain(`b-${b.id}.md`);
		expect(entries[1]?.entryPath).toContain(`a-${a.id}.md`);
	});

	it("returns an empty list when given no ids", async () => {
		await store.create({ type: "requirement", title: "A" });
		expect(await store.exportDocuments([])).toEqual([]);
	});
});

describe("buildVaultZipBase64", () => {
	it("packs each entry at its path with byte-exact content", async () => {
		const base64 = await buildVaultZipBase64([
			{ entryPath: "docs/requirement/a-1.md", content: "---\n_id: '1'\ntype: requirement\n---\nbody a" },
			{ entryPath: "docs/note/b-2.md", content: "---\n_id: '2'\ntype: note\n---\nbody b" },
		]);

		const zip = await JSZip.loadAsync(base64, { base64: true });
		// jszip materializes implicit folder entries; the payload is the files.
		const paths = Object.values(zip.files)
			.filter((file) => !file.dir)
			.map((file) => file.name)
			.sort();
		expect(paths).toEqual(["docs/note/b-2.md", "docs/requirement/a-1.md"]);
		expect(await zip.file("docs/requirement/a-1.md")?.async("string")).toBe(
			"---\n_id: '1'\ntype: requirement\n---\nbody a",
		);
	});

	it("produces an empty archive for no entries", async () => {
		const base64 = await buildVaultZipBase64([]);
		const zip = await JSZip.loadAsync(base64, { base64: true });
		expect(Object.keys(zip.files)).toEqual([]);
	});
});

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseVaultDocument, serializeVaultDocument } from "../../../src/vault/vault-document";
import { VaultDocumentStore } from "../../../src/vault/vault-document-store";
import { getVaultTypesDir } from "../../../src/vault/vault-paths";
import { seedVaultTypeDefinitions } from "../../../src/vault/vault-type-registry";

let repoPath: string;
let store: VaultDocumentStore;

const docsRoot = () => join(repoPath, ".kanban", "files", "docs");

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-vault-store-"));
	// Type defaults (e.g. requirement → status/priority) come from the data-driven
	// `_types/` registry, so seed it the way `prepareRepoRuntimeHome` does in prod.
	await seedVaultTypeDefinitions(getVaultTypesDir(repoPath));
	store = new VaultDocumentStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("VaultDocumentStore.create", () => {
	it("writes a <slug>-<id>.md file and projects the wire document", async () => {
		const doc = await store.create({ type: "requirement", title: "Rate-limit login" });

		expect(doc.type).toBe("requirement");
		expect(doc.title).toBe("Rate-limit login");
		expect(doc.id).toMatch(/^[a-z0-9]+$/);
		expect(doc.relativePath).toBe(join(".kanban", "files", "docs", "requirement", `rate-limit-login-${doc.id}.md`));

		const onDisk = await readFile(join(repoPath, doc.relativePath), "utf8");
		const parsed = parseVaultDocument(onDisk);
		expect(parsed.id).toBe(doc.id);
		expect(parsed.type).toBe("requirement");
	});

	it("seeds the registered type's default frontmatter, then the caller's overrides", async () => {
		const doc = await store.create({
			type: "requirement",
			title: "X",
			frontmatter: { priority: "urgent", customer: "[[acme-corp]]" },
		});

		// requirement defaults: status=proposed, priority=medium; caller overrides priority.
		expect(doc.frontmatter).toMatchObject({ status: "proposed", priority: "urgent", customer: "[[acme-corp]]" });
		// title and timestamps are promoted out of the wire frontmatter.
		expect(doc.frontmatter.title).toBeUndefined();
		expect(doc.frontmatter._created).toBeUndefined();
		expect(doc.frontmatter._updated).toBeUndefined();
	});

	it("stamps created/updated timestamps and the body", async () => {
		let clock = 1000;
		const timed = new VaultDocumentStore(repoPath, { now: () => clock });
		const doc = await timed.create({ type: "requirement", title: "X", body: "the body" });

		expect(doc.createdAt).toBe(1000);
		expect(doc.updatedAt).toBe(1000);
		expect(doc.body).toBe("the body");
		clock = 2000;
	});

	it("stores and serves an unregistered type permissively", async () => {
		const doc = await store.create({ type: "note", title: "Standup", frontmatter: { tag: "daily" } });
		expect(doc.type).toBe("note");
		expect(doc.frontmatter).toEqual({ tag: "daily" });
		expect(await store.get(doc.id)).toMatchObject({ id: doc.id, type: "note" });
	});

	it("assigns unique ids across documents", async () => {
		const a = await store.create({ type: "requirement", title: "A" });
		const b = await store.create({ type: "requirement", title: "B" });
		expect(a.id).not.toBe(b.id);
		expect(await store.list()).toHaveLength(2);
	});
});

describe("VaultDocumentStore.get", () => {
	it("looks documents up by frontmatter id, not by filename slug, and returns null when missing", async () => {
		const created = await store.create({ type: "requirement", title: "Find me" });
		expect(await store.get(created.id)).toMatchObject({ id: created.id, title: "Find me" });
		expect(await store.get("nope")).toBeNull();
	});
});

describe("VaultDocumentStore.list", () => {
	it("lists every type, and filters by a single type when asked", async () => {
		await store.create({ type: "requirement", title: "Req" });
		await store.create({ type: "note", title: "Note" });

		expect(await store.list()).toHaveLength(2);
		const reqs = await store.list("requirement");
		expect(reqs).toHaveLength(1);
		expect(reqs[0]?.type).toBe("requirement");
	});

	it("skips torn / unparseable files during the scan", async () => {
		const good = await store.create({ type: "requirement", title: "Good" });

		// A half-written file with no frontmatter and broken YAML, dropped beside the good doc.
		await writeFile(join(docsRoot(), "requirement", "torn.md"), "---\nnot: [valid", "utf8");

		const listed = await store.list("requirement");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe(good.id);
	});

	it("is empty before any document is written", async () => {
		expect(await store.list()).toEqual([]);
	});

	it("never surfaces the `_types/` type-definition documents as user documents", async () => {
		await store.create({ type: "requirement", title: "Req" });

		const listed = await store.list();
		// `_types/` was seeded in setup, yet the scan excludes `_`-prefixed dirs.
		expect(listed).toHaveLength(1);
		expect(listed.every((doc) => doc.type !== "type")).toBe(true);
	});
});

describe("VaultDocumentStore round-trip stability", () => {
	it("reads back an equivalent document through a fresh store instance", async () => {
		const created = await store.create({
			type: "requirement",
			title: "Persisted",
			body: "body text",
			frontmatter: { priority: "high" },
		});

		const reloaded = await new VaultDocumentStore(repoPath).get(created.id);
		expect(reloaded).toEqual(created);
	});

	it("serializes deterministically so an unchanged re-write produces identical bytes", async () => {
		const created = await store.create({ type: "requirement", title: "Stable" });
		const path = join(repoPath, created.relativePath);

		const first = await readFile(path, "utf8");
		// Re-serializing the parsed document is a no-op on disk.
		expect(serializeVaultDocument(parseVaultDocument(first))).toBe(first);
		const lines = first.split("\n");
		expect(lines[0]).toBe("---");
		// _id and type lead the frontmatter; the id may be YAML-quoted (e.g. an all-digit id).
		expect(lines[1]).toMatch(/^_id: /);
		expect(parseVaultDocument(first).id).toBe(created.id);
		expect(lines[2]).toBe("type: requirement");
	});
});

describe("VaultDocumentStore.update", () => {
	it("merges frontmatter, replaces the body, bumps _updated, and preserves _created", async () => {
		let clock = 1000;
		const timed = new VaultDocumentStore(repoPath, { now: () => clock });
		const created = await timed.create({ type: "requirement", title: "T", frontmatter: { priority: "low" } });

		clock = 5000;
		const updated = await timed.update(created.id, {
			body: "new body",
			frontmatter: { status: "clarified" },
		});

		expect(updated.body).toBe("new body");
		expect(updated.frontmatter).toMatchObject({ status: "clarified", priority: "low" });
		expect(updated.createdAt).toBe(1000);
		expect(updated.updatedAt).toBe(5000);
	});

	it("throws when the document does not exist", async () => {
		await expect(store.update("nope", { body: "x" })).rejects.toThrow(/not found/i);
	});
});

describe("VaultDocumentStore.update title rename", () => {
	it("re-slugs the filename via write-new + remove-old while keeping the id", async () => {
		const created = await store.create({ type: "requirement", title: "Old Title" });
		const oldPath = join(repoPath, created.relativePath);

		const renamed = await store.update(created.id, { title: "Brand New Title" });

		expect(renamed.id).toBe(created.id);
		expect(renamed.title).toBe("Brand New Title");
		expect(renamed.relativePath).toBe(
			join(".kanban", "files", "docs", "requirement", `brand-new-title-${created.id}.md`),
		);

		// Old file is gone; exactly one file remains for this document.
		await expect(readFile(oldPath, "utf8")).rejects.toThrow();
		const files = await readdir(join(docsRoot(), "requirement"));
		expect(files).toEqual([`brand-new-title-${created.id}.md`]);
	});
});

describe("VaultDocumentStore.remove", () => {
	it("deletes the file and returns true, then false for an unknown id", async () => {
		const created = await store.create({ type: "requirement", title: "Doomed" });
		const path = join(repoPath, created.relativePath);

		expect(await store.remove(created.id)).toBe(true);
		expect(await store.get(created.id)).toBeNull();
		await expect(readFile(path, "utf8")).rejects.toThrow();

		expect(await store.remove("nope")).toBe(false);
	});
});

describe("VaultDocumentStore.get direct lookup", () => {
	it("returns the document whose frontmatter id matches, not one whose filename merely ends with the id", async () => {
		// The real document for id "me".
		const real = await store.importDocument({
			id: "me",
			type: "note",
			title: "Standalone",
			createdAt: 1,
			updatedAt: 1,
		});

		// A decoy whose filename ("find-me.md") ends with "-me.md" but whose frontmatter
		// id is something else. A filename-only lookup would wrongly pick this up.
		const decoy = serializeVaultDocument({ id: "zzzzz", type: "note", frontmatter: { title: "Find Me" }, body: "" });
		await writeFile(join(docsRoot(), "note", "find-me.md"), decoy, "utf8");

		const found = await store.get("me");
		expect(found?.id).toBe("me");
		expect(found?.title).toBe("Standalone");
		expect(found?.relativePath).toBe(real.relativePath);
	});

	it("finds a document regardless of which type subdir it lives in", async () => {
		const note = await store.create({ type: "note", title: "A note" });
		const req = await store.create({ type: "requirement", title: "A requirement" });

		expect((await store.get(note.id))?.type).toBe("note");
		expect((await store.get(req.id))?.type).toBe("requirement");
	});
});

describe("VaultDocumentStore mutation lookup robustness", () => {
	it("updates the right document even when a decoy filename ends with the same id segment", async () => {
		const real = await store.importDocument({
			id: "x9",
			type: "requirement",
			title: "Target",
			createdAt: 1,
			updatedAt: 1,
		});
		const decoy = serializeVaultDocument({
			id: "yyyyy",
			type: "requirement",
			frontmatter: { title: "Decoy x9" },
			body: "",
		});
		await writeFile(join(docsRoot(), "requirement", "decoy-x9.md"), decoy, "utf8");

		const updated = await store.update("x9", { body: "real body" });
		expect(updated.id).toBe("x9");
		expect(updated.body).toBe("real body");
		expect(updated.relativePath).toBe(real.relativePath);

		// The decoy is untouched.
		const decoyOnDisk = parseVaultDocument(await readFile(join(docsRoot(), "requirement", "decoy-x9.md"), "utf8"));
		expect(decoyOnDisk.id).toBe("yyyyy");
		expect(decoyOnDisk.body).toBe("");
	});

	it("removes the right document and leaves a same-id-segment decoy in place", async () => {
		await store.importDocument({ id: "x9", type: "requirement", title: "Target", createdAt: 1, updatedAt: 1 });
		const decoy = serializeVaultDocument({
			id: "yyyyy",
			type: "requirement",
			frontmatter: { title: "Decoy x9" },
			body: "",
		});
		await writeFile(join(docsRoot(), "requirement", "decoy-x9.md"), decoy, "utf8");

		expect(await store.remove("x9")).toBe(true);
		expect(await store.get("x9")).toBeNull();
		// Decoy survives.
		const survivors = await readdir(join(docsRoot(), "requirement"));
		expect(survivors).toEqual(["decoy-x9.md"]);
	});
});

describe("VaultDocumentStore concurrency", () => {
	it("serializes concurrent creates so every id is unique and none are lost", async () => {
		const count = 12;
		const created = await Promise.all(
			Array.from({ length: count }, (_, index) => store.create({ type: "requirement", title: `Doc ${index}` })),
		);

		const ids = new Set(created.map((doc) => doc.id));
		expect(ids.size).toBe(count);
		expect(await store.list("requirement")).toHaveLength(count);
	});
});

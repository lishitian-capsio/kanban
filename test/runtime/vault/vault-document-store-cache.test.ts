import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serializeVaultDocument } from "../../../src/vault/vault-document";
import { VaultDocumentStore } from "../../../src/vault/vault-document-store";
import { getVaultTypesDir } from "../../../src/vault/vault-paths";
import { seedVaultTypeDefinitions } from "../../../src/vault/vault-type-registry";

let repoPath: string;
let store: VaultDocumentStore;

const docsRoot = () => join(repoPath, ".kanban", "files", "docs");

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-vault-cache-"));
	await seedVaultTypeDefinitions(getVaultTypesDir(repoPath));
	store = new VaultDocumentStore(repoPath);
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("VaultDocumentStore cached read freshness", () => {
	it("reflects a create made through a different store instance for the same repo", async () => {
		// Warm the shared cache with an empty read.
		expect(await store.list()).toEqual([]);

		const created = await new VaultDocumentStore(repoPath).create({ type: "requirement", title: "Fresh" });

		const listed = await store.list();
		expect(listed.map((d) => d.id)).toEqual([created.id]);
	});

	it("reflects an update (e.g. a board-drag status change) on the next read", async () => {
		const created = await store.create({ type: "requirement", title: "Movable" });
		expect((await store.list())[0]?.frontmatter.status).toBe("proposed");

		await new VaultDocumentStore(repoPath).update(created.id, { frontmatter: { status: "done" } });

		expect((await store.list())[0]?.frontmatter.status).toBe("done");
	});

	it("reflects a delete on the next read", async () => {
		const created = await store.create({ type: "requirement", title: "Doomed" });
		expect(await store.list()).toHaveLength(1);

		await store.remove(created.id);

		expect(await store.list()).toEqual([]);
	});

	it("reflects a document written directly to disk out of process", async () => {
		await store.create({ type: "requirement", title: "In process" });
		expect(await store.list()).toHaveLength(1);

		// A second process / CLI / git pull drops a valid doc file the in-memory cache
		// never saw — the fs signature must catch it on the next read.
		const external = serializeVaultDocument({
			id: "ext1",
			type: "requirement",
			frontmatter: { title: "External", status: "proposed" },
			body: "",
		});
		await writeFile(join(docsRoot(), "requirement", `external-ext1.md`), external, "utf8");

		const ids = (await store.list()).map((d) => d.id).sort();
		expect(ids).toContain("ext1");
		expect(ids).toHaveLength(2);
	});
});

describe("VaultDocumentStore.getLinkIndex", () => {
	it("resolves backlinks across documents and refreshes after a mutation", async () => {
		const target = await store.create({ type: "requirement", title: "Target Doc" });
		await store.create({ type: "note", title: "Linker One", body: "see [[Target Doc]]" });

		const before = (await store.getLinkIndex()).backlinks(target.id);
		expect(before.map((b) => b.sourceTitle)).toEqual(["Linker One"]);

		await store.create({ type: "note", title: "Linker Two", body: "also [[Target Doc]]" });

		const after = (await store.getLinkIndex()).backlinks(target.id);
		expect(after.map((b) => b.sourceTitle).sort()).toEqual(["Linker One", "Linker Two"]);
	});
});

describe("VaultDocumentStore.search", () => {
	it("scores cached documents and reflects newly added documents", async () => {
		await store.create({ type: "requirement", title: "Rate limit login" });

		const first = await store.search("rate");
		expect(first.map((r) => r.title)).toEqual(["Rate limit login"]);

		await store.create({ type: "requirement", title: "Rate cap uploads" });

		const second = await store.search("rate");
		expect(second.map((r) => r.title).sort()).toEqual(["Rate cap uploads", "Rate limit login"]);
	});

	it("restricts results to a requested type", async () => {
		await store.create({ type: "requirement", title: "Alpha thing" });
		await store.create({ type: "note", title: "Alpha note" });

		const results = await store.search("alpha", { type: "note" });
		expect(results.map((r) => r.title)).toEqual(["Alpha note"]);
	});
});

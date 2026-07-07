import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getVaultTypesDir } from "../../../src/vault/vault-paths";
import {
	scanVaultTypeDefinitions,
	seedVaultTypeDefinitions,
	VaultTypeRegistry,
} from "../../../src/vault/vault-type-registry";
import { VAULT_TYPE_SEEDS } from "../../../src/vault/vault-type-seeds";

let repoPath: string;

beforeEach(async () => {
	repoPath = await mkdtemp(join(tmpdir(), "kanban-vault-types-"));
});

afterEach(async () => {
	await rm(repoPath, { recursive: true, force: true });
});

describe("seedVaultTypeDefinitions", () => {
	it("writes one clean <type>.md per seed", async () => {
		const typesDir = getVaultTypesDir(repoPath);
		await seedVaultTypeDefinitions(typesDir);

		const files = (await readdir(typesDir)).sort();
		expect(files).toEqual(["customer.md", "decision.md", "note.md", "requirement.md"]);
	});

	it("is idempotent: a second run does not rewrite existing files", async () => {
		const typesDir = getVaultTypesDir(repoPath);
		await seedVaultTypeDefinitions(typesDir);

		const before = await readFile(join(typesDir, "requirement.md"), "utf8");
		await writeFile(join(typesDir, "requirement.md"), `${before}\n<!-- hand edit -->`);
		await seedVaultTypeDefinitions(typesDir);

		const after = await readFile(join(typesDir, "requirement.md"), "utf8");
		expect(after).toContain("<!-- hand edit -->");
	});
});

describe("scanVaultTypeDefinitions", () => {
	it("returns [] when the directory does not exist", async () => {
		expect(await scanVaultTypeDefinitions(getVaultTypesDir(repoPath))).toEqual([]);
	});

	it("skips an unparseable file and still loads the rest", async () => {
		const typesDir = getVaultTypesDir(repoPath);
		await seedVaultTypeDefinitions(typesDir);
		await writeFile(join(typesDir, "broken.md"), "---\nlabel: No Name\n---\nbody");

		const scanned = await scanVaultTypeDefinitions(typesDir);
		expect(scanned.map((def) => def.type).sort()).toEqual(["customer", "decision", "note", "requirement"]);
	});
});

describe("VaultTypeRegistry", () => {
	it("lists and looks up seeded definitions", async () => {
		await seedVaultTypeDefinitions(getVaultTypesDir(repoPath));
		const registry = new VaultTypeRegistry(repoPath);

		expect((await registry.list()).length).toBe(VAULT_TYPE_SEEDS.length);
		expect((await registry.get("requirement"))?.label).toBe("Requirement");
	});

	it("resolves an unknown type to undefined (permissive)", async () => {
		await seedVaultTypeDefinitions(getVaultTypesDir(repoPath));
		const registry = new VaultTypeRegistry(repoPath);
		expect(await registry.get("spec")).toBeUndefined();
	});

	it("caches the first scan until invalidated", async () => {
		const typesDir = getVaultTypesDir(repoPath);
		await seedVaultTypeDefinitions(typesDir);
		const registry = new VaultTypeRegistry(repoPath);
		await registry.list();

		await mkdir(typesDir, { recursive: true });
		await writeFile(join(typesDir, "spec.md"), "---\nname: spec\nlabel: Spec\n---\n# Spec");

		expect(await registry.get("spec")).toBeUndefined();
		registry.invalidate();
		expect((await registry.get("spec"))?.label).toBe("Spec");
	});

	it("writeDefinition produces a canonical, re-readable file and invalidates the cache", async () => {
		const registry = new VaultTypeRegistry(repoPath);
		await registry.list(); // warm the cache so we prove invalidation

		await registry.writeDefinition({
			type: "spec",
			label: "Spec",
			slugField: "title",
			defaultFrontmatter: { status: "draft" },
			relations: { supersedes: { name: "supersedes", target: "spec", cardinality: "one" } },
			body: "# Spec",
		});

		const written = await registry.get("spec");
		expect(written?.label).toBe("Spec");
		expect(written?.defaultFrontmatter).toEqual({ status: "draft" });
		expect(written?.relations).toEqual({ supersedes: { name: "supersedes", target: "spec", cardinality: "one" } });

		const onDisk = await readFile(join(getVaultTypesDir(repoPath), "spec.md"), "utf8");
		expect(onDisk).toContain("name: spec");
		expect(onDisk).toContain("relations:");
	});

	it("locate finds the backing file by parsed type, not filename", async () => {
		const typesDir = getVaultTypesDir(repoPath);
		await mkdir(typesDir, { recursive: true });
		await writeFile(join(typesDir, "renamed.md"), "---\nname: spec\nlabel: Spec\n---\n# Spec");
		const registry = new VaultTypeRegistry(repoPath);

		expect(await registry.locate("spec")).toBe(join(typesDir, "renamed.md"));
		expect(await registry.locate("missing")).toBeNull();
	});

	it("writeDefinition rewrites the located file in place when targetPath is given", async () => {
		const typesDir = getVaultTypesDir(repoPath);
		await mkdir(typesDir, { recursive: true });
		await writeFile(join(typesDir, "renamed.md"), "---\nname: spec\nlabel: Spec\n---\n# Spec");
		const registry = new VaultTypeRegistry(repoPath);

		const path = await registry.locate("spec");
		await registry.writeDefinition(
			{ type: "spec", label: "Spec v2", slugField: "title", body: "# Spec" },
			path ?? undefined,
		);

		const files = (await readdir(typesDir)).sort();
		expect(files).toEqual(["renamed.md"]); // no orphaned canonical spec.md
		expect((await registry.get("spec"))?.label).toBe("Spec v2");
	});

	it("delete removes the file and returns false for an unknown type", async () => {
		await seedVaultTypeDefinitions(getVaultTypesDir(repoPath));
		const registry = new VaultTypeRegistry(repoPath);

		expect(await registry.delete("note")).toBe(true);
		expect(await registry.get("note")).toBeUndefined();
		expect(await registry.delete("note")).toBe(false);
	});
});

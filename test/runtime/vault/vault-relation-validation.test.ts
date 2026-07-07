import { describe, expect, it } from "vitest";

import { buildVaultLinkIndex, type VaultLinkDocument } from "../../../src/vault/vault-link-index";
import { validateDocumentRelations } from "../../../src/vault/vault-relation-validation";
import type { VaultTypeDefinition } from "../../../src/vault/vault-types";

function doc(partial: Partial<VaultLinkDocument> & Pick<VaultLinkDocument, "id">): VaultLinkDocument {
	return {
		type: "note",
		title: partial.id,
		frontmatter: {},
		body: "",
		...partial,
	};
}

function typeDef(
	type: string,
	relations: VaultTypeDefinition["relations"],
): VaultTypeDefinition {
	return { type, label: type, slugField: "title", body: "", ...(relations ? { relations } : {}) };
}

describe("validateDocumentRelations", () => {
	it("returns no issues when the type declares no relations", () => {
		const source = doc({ id: "src", frontmatter: { blocks: "[[nowhere]]" } });
		const index = buildVaultLinkIndex([source]);

		expect(validateDocumentRelations(source, typeDef("task", undefined), index)).toEqual([]);
	});

	it("flags a dangling link — a declared relation field pointing at nothing", () => {
		const source = doc({ id: "src", type: "task", frontmatter: { blocks: "[[Ghost]]" } });
		const index = buildVaultLinkIndex([source]);

		const issues = validateDocumentRelations(source, typeDef("task", { blocks: { target: "task" } }), index);

		expect(issues).toEqual([
			{ relation: "blocks", kind: "dangling", detail: expect.stringContaining("Ghost") },
		]);
	});

	it("flags a target-type mismatch — a resolved link outside the target whitelist", () => {
		const task = doc({ id: "t1", type: "task", title: "Do the thing", frontmatter: { customer: "[[Acme]]" } });
		const customer = doc({ id: "c1", type: "customer", title: "Acme" });
		const index = buildVaultLinkIndex([task, customer]);

		const issues = validateDocumentRelations(task, typeDef("task", { customer: { target: "requirement" } }), index);

		expect(issues).toEqual([
			{
				relation: "customer",
				kind: "target-type-mismatch",
				detail: expect.stringContaining("customer"),
			},
		]);
	});

	it("accepts a resolved link whose type is in the whitelist (array target)", () => {
		const task = doc({ id: "t1", type: "task", title: "Do the thing", frontmatter: { rel: "[[Acme]]" } });
		const customer = doc({ id: "c1", type: "customer", title: "Acme" });
		const index = buildVaultLinkIndex([task, customer]);

		const issues = validateDocumentRelations(task, typeDef("task", { rel: { target: ["customer", "vendor"] } }), index);

		expect(issues).toEqual([]);
	});

	it("flags a cardinality violation — cardinality 'one' but the field has two links", () => {
		const task = doc({
			id: "t1",
			type: "task",
			title: "Do the thing",
			frontmatter: { owner: ["[[Alice]]", "[[Bob]]"] },
		});
		const alice = doc({ id: "a", type: "person", title: "Alice" });
		const bob = doc({ id: "b", type: "person", title: "Bob" });
		const index = buildVaultLinkIndex([task, alice, bob]);

		const issues = validateDocumentRelations(
			task,
			typeDef("task", { owner: { target: "person", cardinality: "one" } }),
			index,
		);

		expect(issues).toEqual([
			{ relation: "owner", kind: "cardinality", detail: expect.stringContaining("2") },
		]);
	});

	it("does not flag cardinality when 'one' relation has a single link (repeats collapse)", () => {
		const task = doc({
			id: "t1",
			type: "task",
			title: "Do the thing",
			frontmatter: { owner: "[[Alice]] and again [[Alice]]" },
		});
		const alice = doc({ id: "a", type: "person", title: "Alice" });
		const index = buildVaultLinkIndex([task, alice]);

		const issues = validateDocumentRelations(
			task,
			typeDef("task", { owner: { target: "person", cardinality: "one" } }),
			index,
		);

		expect(issues).toEqual([]);
	});

	it("treats an omitted target or '*' as any type (no mismatch)", () => {
		const task = doc({ id: "t1", type: "task", title: "T", frontmatter: { any: "[[Acme]]", wild: "[[Acme]]" } });
		const customer = doc({ id: "c1", type: "customer", title: "Acme" });
		const index = buildVaultLinkIndex([task, customer]);

		const issues = validateDocumentRelations(
			task,
			typeDef("task", { any: {}, wild: { target: "*" } }),
			index,
		);

		expect(issues).toEqual([]);
	});

	it("treats a target array containing '*' as any type", () => {
		const task = doc({ id: "t1", type: "task", title: "T", frontmatter: { rel: "[[Acme]]" } });
		const customer = doc({ id: "c1", type: "customer", title: "Acme" });
		const index = buildVaultLinkIndex([task, customer]);

		const issues = validateDocumentRelations(task, typeDef("task", { rel: { target: ["*", "task"] } }), index);

		expect(issues).toEqual([]);
	});

	it("ignores undeclared frontmatter fields and body links (backward compatible)", () => {
		const task = doc({
			id: "t1",
			type: "task",
			title: "T",
			frontmatter: { blocks: "[[Real]]", undeclared: "[[AlsoGhost]]" },
			body: "see [[BodyGhost]]",
		});
		const real = doc({ id: "r", type: "task", title: "Real" });
		const index = buildVaultLinkIndex([task, real]);

		// Only `blocks` is declared; `undeclared` (dangling) and the body link must be ignored.
		const issues = validateDocumentRelations(task, typeDef("task", { blocks: { target: "task" } }), index);

		expect(issues).toEqual([]);
	});

	it("reports issues per declared relation, mixing kinds", () => {
		const task = doc({
			id: "t1",
			type: "task",
			title: "T",
			frontmatter: {
				owner: ["[[Alice]]", "[[Bob]]"], // cardinality 'one' → violation
				customer: "[[Ghost]]", // dangling
				related: "[[Alice]]", // target mismatch (person, not task)
			},
		});
		const alice = doc({ id: "a", type: "person", title: "Alice" });
		const bob = doc({ id: "b", type: "person", title: "Bob" });
		const index = buildVaultLinkIndex([task, alice, bob]);

		const issues = validateDocumentRelations(
			task,
			typeDef("task", {
				owner: { target: "person", cardinality: "one" },
				customer: { target: "customer" },
				related: { target: "task" },
			}),
			index,
		);

		expect(issues).toEqual([
			{ relation: "owner", kind: "cardinality", detail: expect.any(String) },
			{ relation: "customer", kind: "dangling", detail: expect.any(String) },
			{ relation: "related", kind: "target-type-mismatch", detail: expect.any(String) },
		]);
	});

	it("does not emit a target-type-mismatch for a dangling link (only dangling)", () => {
		const task = doc({ id: "t1", type: "task", title: "T", frontmatter: { customer: "[[Ghost]]" } });
		const index = buildVaultLinkIndex([task]);

		const issues = validateDocumentRelations(task, typeDef("task", { customer: { target: "customer" } }), index);

		expect(issues).toEqual([{ relation: "customer", kind: "dangling", detail: expect.any(String) }]);
	});
});

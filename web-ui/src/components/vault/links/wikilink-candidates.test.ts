import { describe, expect, it } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";
import { createWikilinkCandidateIndex, searchWikilinkCandidates, vaultDocAliases } from "./wikilink-candidates";

function doc(overrides: Partial<VaultDoc> & Pick<VaultDoc, "id" | "name">): VaultDoc {
	return {
		type: "requirement",
		frontmatter: {},
		body: "",
		relativePath: `docs/${overrides.id}.md`,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("vaultDocAliases", () => {
	it("reads string entries from the aliases frontmatter array", () => {
		expect(vaultDocAliases(doc({ id: "1", name: "Acme", frontmatter: { aliases: ["ACME Corp", "acme"] } }))).toEqual([
			"ACME Corp",
			"acme",
		]);
	});

	it("accepts a single string alias", () => {
		expect(vaultDocAliases(doc({ id: "1", name: "Acme", frontmatter: { aliases: "ACME Corp" } }))).toEqual([
			"ACME Corp",
		]);
	});

	it("returns an empty array when absent or non-string", () => {
		expect(vaultDocAliases(doc({ id: "1", name: "Acme" }))).toEqual([]);
		expect(vaultDocAliases(doc({ id: "1", name: "Acme", frontmatter: { aliases: [1, true] } }))).toEqual([]);
	});
});

describe("searchWikilinkCandidates", () => {
	const docs = [
		doc({ id: "a", name: "Acme Corp", type: "customer" }),
		doc({ id: "b", name: "Beta Industries", type: "customer" }),
		doc({ id: "c", name: "Login flow", type: "requirement", frontmatter: { aliases: ["auth"] } }),
	];

	it("returns every candidate (in order) when the query is empty", () => {
		const results = searchWikilinkCandidates(docs, "");
		expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
		expect(results[0]).toMatchObject({ id: "a", type: "customer", title: "Acme Corp" });
	});

	it("fuzzy-matches against the title", () => {
		expect(searchWikilinkCandidates(docs, "acme").map((r) => r.id)).toEqual(["a"]);
	});

	it("matches against an alias, not just the title", () => {
		expect(searchWikilinkCandidates(docs, "auth").map((r) => r.id)).toEqual(["c"]);
	});

	it("excludes the current document", () => {
		expect(searchWikilinkCandidates(docs, "", { excludeId: "a" }).map((r) => r.id)).toEqual(["b", "c"]);
	});

	it("respects the limit", () => {
		expect(searchWikilinkCandidates(docs, "", { limit: 2 })).toHaveLength(2);
	});

	it("carries aliases through on each candidate", () => {
		const result = searchWikilinkCandidates(docs, "login")[0];
		expect(result).toMatchObject({ id: "c", aliases: ["auth"] });
	});
});

describe("createWikilinkCandidateIndex", () => {
	const docs = [
		doc({ id: "a", name: "Acme Corp", type: "customer" }),
		doc({ id: "b", name: "Beta Industries", type: "customer" }),
		doc({ id: "c", name: "Login flow", type: "requirement", frontmatter: { aliases: ["auth"] } }),
	];

	it("answers repeated queries from a single prebuilt index", () => {
		const index = createWikilinkCandidateIndex(docs);
		expect(index.search("acme").map((r) => r.id)).toEqual(["a"]);
		expect(index.search("auth").map((r) => r.id)).toEqual(["c"]);
		expect(index.search("").map((r) => r.id)).toEqual(["a", "b", "c"]);
	});

	it("matches the one-shot helper for the same inputs", () => {
		const index = createWikilinkCandidateIndex(docs);
		for (const query of ["", "acme", "auth", "login", "zzz"]) {
			expect(index.search(query, { limit: 2 })).toEqual(searchWikilinkCandidates(docs, query, { limit: 2 }));
		}
	});

	it("excludes the current document at query time", () => {
		const index = createWikilinkCandidateIndex(docs);
		expect(index.search("", { excludeId: "a" }).map((r) => r.id)).toEqual(["b", "c"]);
		expect(index.search("acme", { excludeId: "a" })).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";
import { buildCandidateWikilinkResolver } from "./candidate-wikilink-resolver";

function doc(partial: Partial<VaultDoc> & { id: string; name: string }): VaultDoc {
	return {
		type: "note",
		frontmatter: {},
		body: "",
		relativePath: `notes/${partial.id}.md`,
		createdAt: 0,
		updatedAt: 0,
		...partial,
	};
}

describe("buildCandidateWikilinkResolver", () => {
	it("resolves a target to its document by title", () => {
		const resolve = buildCandidateWikilinkResolver([doc({ id: "a", name: "Acme Corp", type: "customer" })]);
		expect(resolve("Acme Corp")).toEqual({ id: "a", type: "customer", title: "Acme Corp" });
	});

	it("matches case-insensitively and trims surrounding whitespace", () => {
		const resolve = buildCandidateWikilinkResolver([doc({ id: "a", name: "Acme Corp" })]);
		expect(resolve("  acme corp ")).toEqual({ id: "a", type: "note", title: "Acme Corp" });
	});

	it("returns null when no candidate matches", () => {
		const resolve = buildCandidateWikilinkResolver([doc({ id: "a", name: "Acme Corp" })]);
		expect(resolve("Unknown Thing")).toBeNull();
	});

	it("keeps the first document on a title collision", () => {
		const resolve = buildCandidateWikilinkResolver([
			doc({ id: "first", name: "Roadmap" }),
			doc({ id: "second", name: "Roadmap" }),
		]);
		expect(resolve("Roadmap")?.id).toBe("first");
	});

	it("ignores documents with an empty title", () => {
		const resolve = buildCandidateWikilinkResolver([doc({ id: "a", name: "   " })]);
		expect(resolve("")).toBeNull();
		expect(resolve("   ")).toBeNull();
	});
});

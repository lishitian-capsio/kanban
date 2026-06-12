import { describe, expect, it } from "vitest";

import {
	buildVaultLinkIndex,
	groupBacklinksBySource,
	type VaultLinkDocument,
} from "../../../src/vault/vault-link-index";

function doc(partial: Partial<VaultLinkDocument> & Pick<VaultLinkDocument, "id">): VaultLinkDocument {
	return {
		type: "note",
		title: partial.id,
		frontmatter: {},
		body: "",
		...partial,
	};
}

describe("buildVaultLinkIndex — extraction", () => {
	it("extracts outgoing links from every frontmatter field and the body, tagged by source", () => {
		const source = doc({
			id: "src",
			frontmatter: { customer: "[[Acme]]", related: ["[[Globex|the other one]]"] },
			body: "Context, see [[Initech]] for more.",
		});

		const index = buildVaultLinkIndex([source]);
		const outgoing = index.outgoing("src");

		expect(outgoing).toEqual([
			{
				target: "Acme",
				source: { kind: "frontmatter", field: "customer" },
				resolvedId: null,
				resolvedType: null,
				resolvedTitle: null,
			},
			{
				target: "Globex",
				label: "the other one",
				source: { kind: "frontmatter", field: "related" },
				resolvedId: null,
				resolvedType: null,
				resolvedTitle: null,
			},
			{
				target: "Initech",
				source: { kind: "body" },
				resolvedId: null,
				resolvedType: null,
				resolvedTitle: null,
			},
		]);
	});

	it("de-duplicates per source but keeps the same target across different sources", () => {
		const source = doc({
			id: "src",
			frontmatter: { customer: "[[Acme]] and again [[Acme]]" },
			body: "[[Acme]]",
		});

		const outgoing = buildVaultLinkIndex([source]).outgoing("src");

		expect(outgoing).toHaveLength(2);
		expect(outgoing.map((link) => link.source)).toEqual([{ kind: "frontmatter", field: "customer" }, { kind: "body" }]);
	});

	it("returns an empty list for an unknown document id", () => {
		expect(buildVaultLinkIndex([]).outgoing("nope")).toEqual([]);
	});
});

describe("buildVaultLinkIndex — resolution", () => {
	const acme = doc({ id: "c1", type: "customer", title: "Acme Corp" });

	it("resolves by title, case-insensitively", () => {
		const req = doc({ id: "r1", type: "requirement", frontmatter: { customer: "[[acme CORP]]" } });
		const outgoing = buildVaultLinkIndex([acme, req]).outgoing("r1");
		expect(outgoing[0]).toMatchObject({ resolvedId: "c1", resolvedType: "customer", resolvedTitle: "Acme Corp" });
	});

	it("falls back to the slug when the title does not match verbatim", () => {
		const req = doc({ id: "r1", type: "requirement", frontmatter: { customer: "[[acme-corp]]" } });
		const outgoing = buildVaultLinkIndex([acme, req]).outgoing("r1");
		expect(outgoing[0].resolvedId).toBe("c1");
	});

	it("resolves through an `aliases` frontmatter field", () => {
		const aliased = doc({ id: "c2", type: "customer", title: "Acme Corporation", frontmatter: { aliases: ["Acme", "ACME Inc"] } });
		const req = doc({ id: "r1", type: "requirement", frontmatter: { customer: "[[acme inc]]" } });
		const outgoing = buildVaultLinkIndex([aliased, req]).outgoing("r1");
		expect(outgoing[0].resolvedId).toBe("c2");
	});

	it("leaves the link unresolved when nothing matches", () => {
		const req = doc({ id: "r1", type: "requirement", frontmatter: { customer: "[[Unknown Co]]" } });
		const outgoing = buildVaultLinkIndex([acme, req]).outgoing("r1");
		expect(outgoing[0]).toMatchObject({ resolvedId: null, resolvedType: null, resolvedTitle: null });
	});
});

describe("buildVaultLinkIndex — backlinks", () => {
	it("indexes who links to a document, carrying the source doc identity, label, and source", () => {
		const acme = doc({ id: "c1", type: "customer", title: "Acme Corp" });
		const req = doc({ id: "r1", type: "requirement", title: "Rate-limit login", frontmatter: { customer: "[[Acme Corp|the client]]" } });

		const backlinks = buildVaultLinkIndex([acme, req]).backlinks("c1");

		expect(backlinks).toEqual([
			{
				sourceId: "r1",
				sourceType: "requirement",
				sourceTitle: "Rate-limit login",
				source: { kind: "frontmatter", field: "customer" },
				label: "the client",
			},
		]);
	});

	it("does not index unresolved links as backlinks", () => {
		const req = doc({ id: "r1", type: "requirement", frontmatter: { customer: "[[Ghost]]" } });
		const index = buildVaultLinkIndex([req]);
		expect(index.backlinks("r1")).toEqual([]);
	});

	it("collects backlinks from multiple sources and source fields", () => {
		const acme = doc({ id: "c1", type: "customer", title: "Acme" });
		const reqA = doc({ id: "rA", type: "requirement", title: "A", frontmatter: { customer: "[[Acme]]" } });
		const reqB = doc({ id: "rB", type: "requirement", title: "B", body: "blocked by [[Acme]]" });

		const backlinks = buildVaultLinkIndex([acme, reqA, reqB]).backlinks("c1");

		expect(backlinks.map((entry) => ({ id: entry.sourceId, source: entry.source }))).toEqual([
			{ id: "rA", source: { kind: "frontmatter", field: "customer" } },
			{ id: "rB", source: { kind: "body" } },
		]);
	});
});

describe("groupBacklinksBySource", () => {
	it("groups backlinks by their source field / relationship kind, in first-seen order", () => {
		const acme = doc({ id: "c1", type: "customer", title: "Acme" });
		const reqA = doc({ id: "rA", type: "requirement", title: "A", frontmatter: { customer: "[[Acme]]" } });
		const reqB = doc({ id: "rB", type: "requirement", title: "B", frontmatter: { customer: "[[Acme]]" } });
		const note = doc({ id: "n1", type: "note", title: "N", body: "see [[Acme]]" });

		const backlinks = buildVaultLinkIndex([acme, reqA, reqB, note]).backlinks("c1");
		const groups = groupBacklinksBySource(backlinks);

		expect(groups).toHaveLength(2);
		expect(groups[0].source).toEqual({ kind: "frontmatter", field: "customer" });
		expect(groups[0].backlinks.map((entry) => entry.sourceId)).toEqual(["rA", "rB"]);
		expect(groups[1].source).toEqual({ kind: "body" });
		expect(groups[1].backlinks.map((entry) => entry.sourceId)).toEqual(["n1"]);
	});
});

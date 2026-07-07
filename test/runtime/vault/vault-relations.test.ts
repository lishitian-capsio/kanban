import { describe, expect, it } from "vitest";

import type { VaultLinkDocument } from "../../../src/vault/vault-link-index";
import { buildVaultRelationGraph } from "../../../src/vault/vault-relations";
import type { VaultTypeDefinition } from "../../../src/vault/vault-types";

function doc(partial: Partial<VaultLinkDocument> & { id: string; type: string; title: string }): VaultLinkDocument {
	return { frontmatter: {}, body: "", ...partial };
}

const REQUIREMENT: VaultTypeDefinition = {
	type: "requirement",
	label: "Requirement",
	slugField: "title",
	relations: {
		customer: {
			name: "customer",
			label: "Customer",
			target: "customer",
			cardinality: "one",
			inverse: "requirements",
		},
		depends_on: { name: "depends_on", label: "Depends on", target: "requirement", inverse: "blocks" },
	},
	body: "",
};

const CUSTOMER: VaultTypeDefinition = { type: "customer", label: "Customer", slugField: "title", body: "" };

const DECISION: VaultTypeDefinition = {
	type: "decision",
	label: "Decision",
	slugField: "title",
	relations: {
		supersedes: { name: "supersedes", target: "decision", inverse: "superseded_by" },
	},
	body: "",
};

describe("buildVaultRelationGraph", () => {
	it("resolves a well-formed relation and reports no issues", () => {
		const docs = [
			doc({ id: "c1", type: "customer", title: "Acme Corp" }),
			doc({ id: "r1", type: "requirement", title: "Faster export", frontmatter: { customer: "[[Acme Corp]]" } }),
		];
		const graph = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER]);

		const edges = graph.edges("r1");
		expect(edges).toHaveLength(2);
		const customerEdge = edges.find((e) => e.relation === "customer")!;
		expect(customerEdge.targets).toEqual([
			{ target: "Acme Corp", resolvedId: "c1", resolvedType: "customer", resolvedTitle: "Acme Corp" },
		]);
		expect(customerEdge.cardinalityViolation).toBe(false);
		expect(graph.issues()).toEqual([]);
	});

	it("flags a wikilink that resolves to nothing as dangling", () => {
		const docs = [doc({ id: "r1", type: "requirement", title: "R1", frontmatter: { customer: "[[Ghost Co]]" } })];
		const issues = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER]).issues();
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ docId: "r1", relation: "customer", kind: "dangling", target: "Ghost Co" });
	});

	it("flags a present-but-non-wikilink relation value as dangling (raw id typo)", () => {
		const docs = [
			doc({ id: "c1", type: "customer", title: "Acme Corp" }),
			doc({ id: "r1", type: "requirement", title: "R1", frontmatter: { customer: "c1" } }),
		];
		const issues = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER]).issues();
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ relation: "customer", kind: "dangling", target: "c1" });
	});

	it("flags a target of the wrong type", () => {
		const docs = [
			doc({ id: "d1", type: "decision", title: "Some decision" }),
			doc({ id: "r1", type: "requirement", title: "R1", frontmatter: { customer: "[[Some decision]]" } }),
		];
		const issues = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER, DECISION]).issues();
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			relation: "customer",
			kind: "type_mismatch",
			target: "Some decision",
			resolvedType: "decision",
			expectedTarget: "customer",
		});
	});

	it("flags a cardinality-one relation with multiple targets", () => {
		const docs = [
			doc({ id: "c1", type: "customer", title: "Acme" }),
			doc({ id: "c2", type: "customer", title: "Globex" }),
			doc({ id: "r1", type: "requirement", title: "R1", frontmatter: { customer: ["[[Acme]]", "[[Globex]]"] } }),
		];
		const issues = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER]).issues();
		const cardinality = issues.find((i) => i.kind === "cardinality")!;
		expect(cardinality).toMatchObject({ relation: "customer", kind: "cardinality", count: 2 });
	});

	it("allows many targets for a cardinality-many relation", () => {
		const docs = [
			doc({ id: "r1", type: "requirement", title: "R1" }),
			doc({ id: "r2", type: "requirement", title: "R2" }),
			doc({ id: "r3", type: "requirement", title: "R3", frontmatter: { depends_on: ["[[R1]]", "[[R2]]"] } }),
		];
		const graph = buildVaultRelationGraph(docs, [REQUIREMENT]);
		expect(graph.issues()).toEqual([]);
		expect(graph.edges("r3").find((e) => e.relation === "depends_on")!.targets).toHaveLength(2);
	});

	it("narrows issues by type and relation", () => {
		const docs = [
			doc({
				id: "r1",
				type: "requirement",
				title: "R1",
				frontmatter: { customer: "[[Ghost]]", depends_on: "[[Nope]]" },
			}),
			doc({ id: "d1", type: "decision", title: "D1", frontmatter: { supersedes: "[[Missing]]" } }),
		];
		const graph = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER, DECISION]);
		expect(graph.issues({ type: "decision" }).map((i) => i.docId)).toEqual(["d1"]);
		expect(graph.issues({ relation: "customer" }).map((i) => i.relation)).toEqual(["customer"]);
	});

	it("derives inbound (reverse) edges", () => {
		const docs = [
			doc({ id: "c1", type: "customer", title: "Acme" }),
			doc({ id: "r1", type: "requirement", title: "R1", frontmatter: { customer: "[[Acme]]" } }),
			doc({ id: "r2", type: "requirement", title: "R2", frontmatter: { customer: "[[Acme]]" } }),
		];
		const graph = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER]);
		const inbound = graph.inbound("c1");
		expect(inbound.map((i) => i.sourceId).sort()).toEqual(["r1", "r2"]);
		expect(inbound.every((i) => i.relation === "customer")).toBe(true);
	});

	it("traverses a forward relation chain up to a depth", () => {
		const docs = [
			doc({ id: "d1", type: "decision", title: "D1" }),
			doc({ id: "d2", type: "decision", title: "D2", frontmatter: { supersedes: "[[D1]]" } }),
			doc({ id: "d3", type: "decision", title: "D3", frontmatter: { supersedes: "[[D2]]" } }),
		];
		const graph = buildVaultRelationGraph(docs, [DECISION]);

		const oneHop = graph.traverse("d3", { relation: "supersedes" });
		expect(oneHop?.nodes.map((n) => n.id)).toEqual(["d2"]);

		const twoHop = graph.traverse("d3", { relation: "supersedes", maxDepth: 2 });
		expect(twoHop?.nodes.map((n) => n.id)).toEqual(["d2", "d1"]);
		expect(twoHop?.nodes.map((n) => n.depth)).toEqual([1, 2]);
	});

	it("traverses inverse (reverse) edges", () => {
		const docs = [
			doc({ id: "c1", type: "customer", title: "Acme" }),
			doc({ id: "r1", type: "requirement", title: "R1", frontmatter: { customer: "[[Acme]]" } }),
			doc({ id: "r2", type: "requirement", title: "R2", frontmatter: { customer: "[[Acme]]" } }),
		];
		const graph = buildVaultRelationGraph(docs, [REQUIREMENT, CUSTOMER]);
		const result = graph.traverse("c1", { direction: "inverse" });
		expect(result?.nodes.map((n) => n.id).sort()).toEqual(["r1", "r2"]);
	});

	it("stops a cyclic forward walk without looping", () => {
		const docs = [
			doc({ id: "d1", type: "decision", title: "D1", frontmatter: { supersedes: "[[D2]]" } }),
			doc({ id: "d2", type: "decision", title: "D2", frontmatter: { supersedes: "[[D1]]" } }),
		];
		const graph = buildVaultRelationGraph(docs, [DECISION]);
		const result = graph.traverse("d1", { relation: "supersedes", maxDepth: 10 });
		expect(result?.nodes.map((n) => n.id)).toEqual(["d2"]);
	});

	it("records unresolved targets encountered while traversing forward", () => {
		const docs = [doc({ id: "d1", type: "decision", title: "D1", frontmatter: { supersedes: "[[Gone]]" } })];
		const graph = buildVaultRelationGraph(docs, [DECISION]);
		const result = graph.traverse("d1", { relation: "supersedes" });
		expect(result?.nodes).toEqual([]);
		expect(result?.unresolved).toEqual([{ fromId: "d1", relation: "supersedes", target: "Gone" }]);
	});

	it("returns null when the start document is unknown", () => {
		expect(buildVaultRelationGraph([], [DECISION]).traverse("nope")).toBeNull();
	});

	it("returns no edges for a type without declared relations", () => {
		const docs = [doc({ id: "c1", type: "customer", title: "Acme", frontmatter: { customer: "[[Whatever]]" } })];
		const graph = buildVaultRelationGraph(docs, [CUSTOMER]);
		expect(graph.edges("c1")).toEqual([]);
		expect(graph.issues()).toEqual([]);
	});
});

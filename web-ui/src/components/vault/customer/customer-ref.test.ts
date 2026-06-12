import { describe, expect, it } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";
import {
	customerRefLabel,
	customerRefValue,
	findCustomerBacklinks,
	parseWikilinkTarget,
	readMaterialIds,
	refMatchesCustomer,
	resolveCustomerRef,
} from "./customer-ref";

function makeCustomer(id: string, name: string): VaultDoc {
	return {
		id,
		type: "customer",
		name,
		frontmatter: {},
		body: "",
		relativePath: `docs/customer/${id}.md`,
		createdAt: 1,
		updatedAt: 1,
	};
}

function makeRequirement(id: string, customer: VaultDoc["frontmatter"]["customer"]): VaultDoc {
	return {
		id,
		type: "requirement",
		name: `Req ${id}`,
		frontmatter: { customer },
		body: "",
		relativePath: `docs/requirement/${id}.md`,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("parseWikilinkTarget", () => {
	it("extracts the target from a wikilink", () => {
		expect(parseWikilinkTarget("[[Acme Corp]]")).toBe("Acme Corp");
		expect(parseWikilinkTarget("  [[ Acme Corp ]] ")).toBe("Acme Corp");
	});

	it("returns null for a non-wikilink string", () => {
		expect(parseWikilinkTarget("Acme Corp")).toBeNull();
		expect(parseWikilinkTarget("")).toBeNull();
	});
});

describe("customerRefValue / customerRefLabel", () => {
	it("round-trips a customer name through a wikilink", () => {
		const customer = makeCustomer("c1", "Acme Corp");
		const ref = customerRefValue(customer);
		expect(ref).toBe("[[Acme Corp]]");
		expect(customerRefLabel(ref)).toBe("Acme Corp");
	});

	it("falls back to the raw value for a plain (legacy) ref", () => {
		expect(customerRefLabel("Acme Corp")).toBe("Acme Corp");
		expect(customerRefLabel("")).toBe("");
		expect(customerRefLabel(null)).toBe("");
	});
});

describe("refMatchesCustomer / resolveCustomerRef", () => {
	const acme = makeCustomer("c1", "Acme Corp");
	const globex = makeCustomer("c2", "Globex");

	it("matches a wikilink ref to the customer by name (case-insensitive)", () => {
		expect(refMatchesCustomer("[[Acme Corp]]", acme)).toBe(true);
		expect(refMatchesCustomer("[[acme corp]]", acme)).toBe(true);
		expect(refMatchesCustomer("[[Globex]]", acme)).toBe(false);
	});

	it("matches a plain (legacy) ref by name", () => {
		expect(refMatchesCustomer("Acme Corp", acme)).toBe(true);
	});

	it("does not match an empty ref", () => {
		expect(refMatchesCustomer("", acme)).toBe(false);
		expect(refMatchesCustomer("[[]]", acme)).toBe(false);
	});

	it("resolves a ref against a customer list", () => {
		expect(resolveCustomerRef("[[Globex]]", [acme, globex])).toBe(globex);
		expect(resolveCustomerRef("[[Nobody]]", [acme, globex])).toBeUndefined();
		expect(resolveCustomerRef("", [acme, globex])).toBeUndefined();
	});
});

describe("findCustomerBacklinks", () => {
	const acme = makeCustomer("c1", "Acme Corp");

	it("returns requirements whose customer ref points at the customer", () => {
		const requirements = [
			makeRequirement("r1", "[[Acme Corp]]"),
			makeRequirement("r2", "[[Globex]]"),
			makeRequirement("r3", "Acme Corp"),
			makeRequirement("r4", null),
			makeRequirement("r5", ""),
		];
		const backlinks = findCustomerBacklinks(acme, requirements);
		expect(backlinks.map((doc) => doc.id)).toEqual(["r1", "r3"]);
	});
});

describe("readMaterialIds", () => {
	it("reads a string array, ignoring non-string entries", () => {
		const doc = makeCustomer("c1", "Acme");
		doc.frontmatter.materials = ["f1", "f2", 3, "f4"];
		expect(readMaterialIds(doc)).toEqual(["f1", "f2", "f4"]);
	});

	it("returns an empty array when materials is missing or not an array", () => {
		expect(readMaterialIds(makeCustomer("c1", "Acme"))).toEqual([]);
		const doc = makeCustomer("c2", "Globex");
		doc.frontmatter.materials = "f1";
		expect(readMaterialIds(doc)).toEqual([]);
	});
});

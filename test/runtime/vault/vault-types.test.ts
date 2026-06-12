import { describe, expect, it } from "vitest";

import {
	getVaultTypeDefinition,
	listVaultTypeDefinitions,
	REQUIREMENT_PROBLEM_STATUSES,
} from "../../../src/vault/vault-types";

describe("vaultTypeRegistry", () => {
	it("exposes the requirement type with a title slug field and the problem-state status enum", () => {
		const def = getVaultTypeDefinition("requirement");

		expect(def).toBeDefined();
		expect(def?.type).toBe("requirement");
		expect(def?.slugField).toBe("title");
		expect(def?.statusEnum).toEqual(["proposed", "clarified", "parked", "invalid"]);
	});

	it("returns undefined for an unregistered type", () => {
		expect(getVaultTypeDefinition("spec")).toBeUndefined();
	});

	it("registers the customer anchor type without a status lifecycle", () => {
		const def = getVaultTypeDefinition("customer");
		expect(def).toBeDefined();
		expect(def?.slugField).toBe("title");
		expect(def?.statusEnum).toBeUndefined();
	});

	it("registers the decision type with an ADR status enum", () => {
		const def = getVaultTypeDefinition("decision");
		expect(def?.statusEnum).toEqual(["proposed", "accepted", "superseded", "rejected"]);
		expect(def?.defaultFrontmatter).toEqual({ status: "proposed" });
	});

	it("registers the note type for crystallized minutes", () => {
		expect(getVaultTypeDefinition("note")?.type).toBe("note");
	});

	it("lists the requirement definition", () => {
		expect(listVaultTypeDefinitions().some((def) => def.type === "requirement")).toBe(true);
	});

	it("defaults a new requirement to proposed/medium", () => {
		expect(getVaultTypeDefinition("requirement")?.defaultFrontmatter).toEqual({
			status: "proposed",
			priority: "medium",
		});
	});
});

describe("requirement frontmatter schema", () => {
	const schema = getVaultTypeDefinition("requirement")?.frontmatterSchema;

	it("accepts a well-formed requirement", () => {
		expect(
			schema?.safeParse({
				title: "Rate-limit login",
				status: "clarified",
				priority: "high",
				customer: "[[acme-corp]]",
				related_tasks: ["task-7f3a9"],
				_created: 1739000000000,
				_updated: 1739000000000,
			}).success,
		).toBe(true);
	});

	it("rejects a delivery-flavored status", () => {
		expect(schema?.safeParse({ title: "x", status: "done", priority: "high" }).success).toBe(false);
	});

	it("rejects an unknown priority", () => {
		expect(schema?.safeParse({ title: "x", status: "proposed", priority: "p0" }).success).toBe(false);
	});
});

describe("REQUIREMENT_PROBLEM_STATUSES", () => {
	it("is the ordered problem lifecycle", () => {
		expect(REQUIREMENT_PROBLEM_STATUSES).toEqual(["proposed", "clarified", "parked", "invalid"]);
	});
});

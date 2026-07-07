import { describe, expect, it } from "vitest";

import { VAULT_TYPE_SEEDS } from "../../../src/vault/vault-type-seeds";
import {
	parseVaultTypeDefinition,
	serializeVaultTypeDefinition,
	type VaultTypeDefinition,
	VaultTypeDefinitionParseError,
	validateVaultTypeRelations,
} from "../../../src/vault/vault-types";

describe("parseVaultTypeDefinition", () => {
	it("maps skill-aligned frontmatter onto a definition and keeps the body verbatim", () => {
		const raw = [
			"---",
			"name: requirement",
			"label: Requirement",
			"description: A customer-facing problem statement.",
			"icon: ClipboardList",
			"slug_field: title",
			"status_enum: [proposed, clarified, parked, invalid]",
			"default_frontmatter:",
			"  status: proposed",
			"  priority: medium",
			"---",
			"",
			"# How to author a Requirement",
			"",
			"State the problem from the customer's point of view.",
		].join("\n");

		const def = parseVaultTypeDefinition(raw);

		expect(def.type).toBe("requirement");
		expect(def.label).toBe("Requirement");
		expect(def.description).toBe("A customer-facing problem statement.");
		expect(def.icon).toBe("ClipboardList");
		expect(def.slugField).toBe("title");
		expect(def.statusEnum).toEqual(["proposed", "clarified", "parked", "invalid"]);
		expect(def.defaultFrontmatter).toEqual({ status: "proposed", priority: "medium" });
		expect(def.body).toBe("# How to author a Requirement\n\nState the problem from the customer's point of view.");
	});

	it("defaults the slug field to title when omitted", () => {
		const def = parseVaultTypeDefinition("---\nname: note\nlabel: Note\n---\nbody");
		expect(def.slugField).toBe("title");
		expect(def.statusEnum).toBeUndefined();
		expect(def.defaultFrontmatter).toBeUndefined();
	});

	it("throws when `name` is missing", () => {
		expect(() => parseVaultTypeDefinition("---\nlabel: Note\n---\nbody")).toThrow(VaultTypeDefinitionParseError);
	});

	it("throws when `label` is missing", () => {
		expect(() => parseVaultTypeDefinition("---\nname: note\n---\nbody")).toThrow(VaultTypeDefinitionParseError);
	});

	it("maps a nested `relations:` map onto typed relation definitions", () => {
		const raw = [
			"---",
			"name: task",
			"label: Task",
			"relations:",
			"  blocks:",
			"    label: Blocks",
			"    target: task",
			"    cardinality: many",
			"    inverse: blocked_by",
			"    inverse_label: Blocked by",
			"  implements:",
			"    target: [requirement, decision]",
			"    cardinality: one",
			"---",
			"body",
		].join("\n");

		const def = parseVaultTypeDefinition(raw);

		expect(def.relations).toEqual({
			blocks: {
				name: "blocks",
				label: "Blocks",
				target: "task",
				cardinality: "many",
				inverse: "blocked_by",
				inverseLabel: "Blocked by",
			},
			implements: {
				name: "implements",
				target: ["requirement", "decision"],
				cardinality: "one",
			},
		});
	});

	it("leaves relations undefined when omitted", () => {
		const def = parseVaultTypeDefinition("---\nname: note\nlabel: Note\n---\nbody");
		expect(def.relations).toBeUndefined();
	});

	it("tolerates a broken / half-written relations block by skipping bad entries", () => {
		const raw = [
			"---",
			"name: task",
			"label: Task",
			"relations:",
			"  good:",
			"    target: task",
			"  scalar_instead_of_map: oops",
			"  list_instead_of_map:",
			"    - nope",
			"  bad_cardinality:",
			"    cardinality: sometimes",
			"---",
			"body",
		].join("\n");

		const def = parseVaultTypeDefinition(raw);

		// The two non-map entries are dropped; the enum-invalid cardinality is ignored
		// but the (otherwise valid) relation survives without it.
		expect(def.relations).toEqual({
			good: { name: "good", target: "task" },
			bad_cardinality: { name: "bad_cardinality" },
		});
	});

	it("ignores a relations value that is not a map", () => {
		const def = parseVaultTypeDefinition("---\nname: task\nlabel: Task\nrelations: nonsense\n---\nbody");
		expect(def.relations).toBeUndefined();
	});
});

describe("serialize → parse round-trip", () => {
	it("survives the round-trip for every seed, preserving the nested default_frontmatter", () => {
		for (const seed of VAULT_TYPE_SEEDS) {
			const reparsed = parseVaultTypeDefinition(serializeVaultTypeDefinition(seed));
			expect(reparsed).toEqual(seed);
		}
	});

	it("keeps a nested default_frontmatter as a map (not coerced to a string)", () => {
		const def: VaultTypeDefinition = {
			type: "spec",
			label: "Spec",
			slugField: "title",
			defaultFrontmatter: { status: "draft", owner: "platform" },
			body: "# Spec",
		};
		const reparsed = parseVaultTypeDefinition(serializeVaultTypeDefinition(def));
		expect(reparsed.defaultFrontmatter).toEqual({ status: "draft", owner: "platform" });
	});

	it("preserves a typed relations map across the round-trip", () => {
		const def: VaultTypeDefinition = {
			type: "task",
			label: "Task",
			slugField: "title",
			relations: {
				blocks: {
					name: "blocks",
					label: "Blocks",
					target: ["task", "requirement"],
					cardinality: "many",
					inverse: "blocked_by",
					inverseLabel: "Blocked by",
				},
				anyTarget: { name: "anyTarget", target: "*", cardinality: "one" },
			},
			body: "# Task",
		};
		const reparsed = parseVaultTypeDefinition(serializeVaultTypeDefinition(def));
		expect(reparsed.relations).toEqual(def.relations);
	});
});

describe("validateVaultTypeRelations", () => {
	const baseType = (relations: VaultTypeDefinition["relations"], type = "task"): VaultTypeDefinition => ({
		type,
		label: "Task",
		slugField: "title",
		body: "",
		relations,
	});

	it("passes when there are no relations", () => {
		expect(validateVaultTypeRelations({ type: "note", label: "Note", slugField: "title", body: "" }, [])).toEqual([]);
	});

	it("accepts a relation whose target type exists", () => {
		const requirement: VaultTypeDefinition = {
			type: "requirement",
			label: "Requirement",
			slugField: "title",
			body: "",
		};
		const def = baseType({ implements: { name: "implements", target: "requirement", cardinality: "one" } });
		expect(validateVaultTypeRelations(def, [requirement])).toEqual([]);
	});

	it("accepts an omitted or wildcard target as 'any'", () => {
		const def = baseType({
			mentions: { name: "mentions" },
			anything: { name: "anything", target: "*" },
		});
		expect(validateVaultTypeRelations(def, [])).toEqual([]);
	});

	it("resolves a self-referential target against the type being written", () => {
		const def = baseType({ related: { name: "related", target: "task" } });
		expect(validateVaultTypeRelations(def, [])).toEqual([]);
	});

	it("rejects a target type that does not exist", () => {
		const def = baseType({ implements: { name: "implements", target: "requirement" } });
		const errors = validateVaultTypeRelations(def, []);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('targets unknown type "requirement"');
	});

	it("rejects an invalid relation name and a bad cardinality", () => {
		const def = baseType({
			"1bad": { name: "1bad", target: "*" },
			ok: { name: "ok", target: "*", cardinality: "sometimes" as unknown as "one" },
		});
		const errors = validateVaultTypeRelations(def, []);
		expect(errors.some((e) => e.includes('relation "1bad" has an invalid name'))).toBe(true);
		expect(errors.some((e) => e.includes('invalid cardinality "sometimes"'))).toBe(true);
	});

	it("rejects an inverse with no concrete target to bind to", () => {
		const def = baseType({ blocks: { name: "blocks", target: "*", inverse: "blocked_by" } });
		const errors = validateVaultTypeRelations(def, []);
		expect(errors[0]).toContain("has no concrete target type to bind it to");
	});

	it("rejects an inverse when the target type lacks the named reverse relation", () => {
		const other: VaultTypeDefinition = { type: "requirement", label: "Requirement", slugField: "title", body: "" };
		const def = baseType({ implements: { name: "implements", target: "requirement", inverse: "implemented_by" } });
		const errors = validateVaultTypeRelations(def, [other]);
		expect(errors[0]).toContain('type "requirement" has no relation named "implemented_by"');
	});

	it("rejects an inverse whose reverse relation does not point back", () => {
		const other: VaultTypeDefinition = {
			type: "requirement",
			label: "Requirement",
			slugField: "title",
			body: "",
			relations: { implemented_by: { name: "implemented_by", target: "note" } },
		};
		const def = baseType({ implements: { name: "implements", target: "requirement", inverse: "implemented_by" } });
		const errors = validateVaultTypeRelations(def, [other]);
		expect(errors[0]).toContain('does not target "task"');
	});

	it("accepts a well-formed inverse whose reverse relation points back (or is any)", () => {
		const other: VaultTypeDefinition = {
			type: "requirement",
			label: "Requirement",
			slugField: "title",
			body: "",
			relations: { implemented_by: { name: "implemented_by", target: "task" } },
		};
		const def = baseType({ implements: { name: "implements", target: "requirement", inverse: "implemented_by" } });
		expect(validateVaultTypeRelations(def, [other])).toEqual([]);
	});

	it("accepts a mutually-inverse pair declared within one self-referential type", () => {
		const def = baseType({
			blocks: { name: "blocks", target: "task", inverse: "blocked_by" },
			blocked_by: { name: "blocked_by", target: "task", inverse: "blocks" },
		});
		expect(validateVaultTypeRelations(def, [])).toEqual([]);
	});
});

describe("VAULT_TYPE_SEEDS", () => {
	it("ships the four built-in types with their original metadata", () => {
		const byType = new Map(VAULT_TYPE_SEEDS.map((seed) => [seed.type, seed]));
		expect(byType.get("requirement")?.statusEnum).toEqual(["proposed", "clarified", "parked", "invalid"]);
		expect(byType.get("requirement")?.defaultFrontmatter).toEqual({ status: "proposed", priority: "medium" });
		expect(byType.get("customer")?.statusEnum).toBeUndefined();
		expect(byType.get("decision")?.statusEnum).toEqual(["proposed", "accepted", "superseded", "rejected"]);
		expect(byType.get("decision")?.defaultFrontmatter).toEqual({ status: "proposed" });
		expect(byType.get("note")?.type).toBe("note");
	});
});

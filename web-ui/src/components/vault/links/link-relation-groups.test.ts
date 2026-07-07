import { describe, expect, it } from "vitest";

import type { RuntimeVaultBacklink, RuntimeVaultOutgoingLink } from "@/runtime/types";

import { backlinkLabel, groupBacklinks, groupOutgoingLinks, outgoingLinkLabel } from "./link-relation-groups";

const relation = {
	name: "customer",
	label: "Serves customer",
	inverse: "requirements",
	inverseLabel: "Requirements",
	directed: true,
};

function outgoing(overrides: Partial<RuntimeVaultOutgoingLink> & Pick<RuntimeVaultOutgoingLink, "target">): RuntimeVaultOutgoingLink {
	return {
		source: { kind: "frontmatter", field: "customer" },
		resolvedId: null,
		resolvedType: null,
		resolvedTitle: null,
		...overrides,
	};
}

function backlink(overrides: Partial<RuntimeVaultBacklink> & Pick<RuntimeVaultBacklink, "sourceId">): RuntimeVaultBacklink {
	return {
		sourceType: "requirement",
		sourceTitle: overrides.sourceId,
		source: { kind: "frontmatter", field: "customer" },
		...overrides,
	};
}

describe("outgoingLinkLabel", () => {
	it("uses the relation's forward label when present", () => {
		expect(outgoingLinkLabel(outgoing({ target: "Acme", relation }))).toBe("Serves customer");
	});

	it("falls back to the relation name when the relation has no label", () => {
		expect(outgoingLinkLabel(outgoing({ target: "Acme", relation: { name: "blocks", directed: true } }))).toBe("blocks");
	});

	it("falls back to the bare source key when there is no relation", () => {
		expect(outgoingLinkLabel(outgoing({ target: "Acme" }))).toBe("frontmatter:customer");
		expect(outgoingLinkLabel(outgoing({ target: "Acme", source: { kind: "body" } }))).toBe("body");
	});
});

describe("backlinkLabel", () => {
	it("uses the relation's inverse label when present", () => {
		expect(backlinkLabel(backlink({ sourceId: "r1", relation }))).toBe("Requirements");
	});

	it("falls back to the bare source key when there is no relation", () => {
		expect(backlinkLabel(backlink({ sourceId: "r1" }))).toBe("frontmatter:customer");
	});
});

describe("groupOutgoingLinks / groupBacklinks", () => {
	it("groups by source key in first-seen order, using the human label", () => {
		const groups = groupOutgoingLinks([
			outgoing({ target: "Acme", relation }),
			outgoing({ target: "Globex", relation }),
			outgoing({ target: "Note", source: { kind: "body" } }),
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({ key: "frontmatter:customer", label: "Serves customer" });
		expect(groups[0]?.links.map((link) => link.target)).toEqual(["Acme", "Globex"]);
		expect(groups[1]).toMatchObject({ key: "body", label: "body" });
	});

	it("groups backlinks by their inverse-direction human label", () => {
		const groups = groupBacklinks([backlink({ sourceId: "r1", relation }), backlink({ sourceId: "r2", relation })]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("Requirements");
		expect(groups[0]?.links.map((link) => link.sourceId)).toEqual(["r1", "r2"]);
	});
});

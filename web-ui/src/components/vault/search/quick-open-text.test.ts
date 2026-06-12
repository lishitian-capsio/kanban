import { describe, expect, it } from "vitest";

import type { VaultDoc } from "../data/vault-doc-model";

import { quickOpenSearchText } from "./quick-open-text";

function doc(overrides: Partial<VaultDoc>): VaultDoc {
	return {
		id: "id",
		type: "requirement",
		name: "Untitled",
		frontmatter: {},
		body: "",
		relativePath: "docs/requirement/id.md",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("quickOpenSearchText", () => {
	it("includes the title", () => {
		expect(quickOpenSearchText(doc({ name: "Login throttle" }))).toContain("Login throttle");
	});

	it("appends string aliases from frontmatter", () => {
		const text = quickOpenSearchText(doc({ name: "Login throttle", frontmatter: { aliases: "rate limit" } }));
		expect(text).toContain("Login throttle");
		expect(text).toContain("rate limit");
	});

	it("appends each alias from an array, ignoring non-string entries", () => {
		const text = quickOpenSearchText(
			doc({ name: "Doc", frontmatter: { aliases: ["foo", 42, "bar"] } as VaultDoc["frontmatter"] }),
		);
		expect(text).toContain("foo");
		expect(text).toContain("bar");
		expect(text).not.toContain("42");
	});

	it("ignores a missing or null aliases field", () => {
		expect(quickOpenSearchText(doc({ name: "Solo", frontmatter: { aliases: null } }))).toBe("Solo");
		expect(quickOpenSearchText(doc({ name: "Solo" }))).toBe("Solo");
	});
});

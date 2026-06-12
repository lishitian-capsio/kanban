import { describe, expect, it } from "vitest";

import type { RuntimeVaultDocument } from "../../../src/core/api-contract";
import { searchVaultDocuments } from "../../../src/vault/vault-search";

function doc(overrides: Partial<RuntimeVaultDocument> & Pick<RuntimeVaultDocument, "id" | "title">): RuntimeVaultDocument {
	return {
		type: "requirement",
		body: "",
		frontmatter: {},
		relativePath: `docs/requirement/${overrides.id}.md`,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("searchVaultDocuments", () => {
	it("returns nothing for an empty or whitespace query", () => {
		const docs = [doc({ id: "a", title: "Rate limit login" })];
		expect(searchVaultDocuments(docs, "")).toEqual([]);
		expect(searchVaultDocuments(docs, "   ")).toEqual([]);
	});

	it("ranks a title hit above a body-only hit", () => {
		const titleHit = doc({ id: "title", title: "Login rate limit", body: "unrelated content" });
		const bodyHit = doc({ id: "body", title: "Unrelated feature", body: "we should add a rate limit to login" });

		const results = searchVaultDocuments([bodyHit, titleHit], "login");

		expect(results.map((r) => r.id)).toEqual(["title", "body"]);
		expect(results[0].field).toBe("title");
		expect(results[0].score).toBeGreaterThan(results[1].score);
	});

	it("ranks a frontmatter keyword hit between title and body hits", () => {
		const titleHit = doc({ id: "title", title: "acme onboarding" });
		const frontmatterHit = doc({ id: "fm", title: "Some requirement", frontmatter: { customer: "acme" } });
		const bodyHit = doc({ id: "body", title: "Other requirement", body: "acme is mentioned here" });

		const results = searchVaultDocuments([bodyHit, frontmatterHit, titleHit], "acme");

		expect(results.map((r) => r.id)).toEqual(["title", "fm", "body"]);
		expect(results[1].field).toBe("frontmatter");
	});

	it("matches case-insensitively", () => {
		const results = searchVaultDocuments([doc({ id: "a", title: "Rate Limit LOGIN" })], "login");
		expect(results.map((r) => r.id)).toEqual(["a"]);
	});

	it("requires every whitespace-separated term to match (AND semantics)", () => {
		const both = doc({ id: "both", title: "rate limit on the login endpoint" });
		const onlyOne = doc({ id: "one", title: "rate limit on the signup endpoint" });

		const results = searchVaultDocuments([both, onlyOne], "rate login");

		expect(results.map((r) => r.id)).toEqual(["both"]);
	});

	it("ranks an exact title above a partial title match", () => {
		const exact = doc({ id: "exact", title: "login" });
		const partial = doc({ id: "partial", title: "login rate limit policy" });

		const results = searchVaultDocuments([partial, exact], "login");

		expect(results.map((r) => r.id)).toEqual(["exact", "partial"]);
	});

	it("matches array frontmatter values (e.g. tags)", () => {
		const results = searchVaultDocuments(
			[doc({ id: "a", title: "Some doc", frontmatter: { tags: ["billing", "urgent"] } })],
			"billing",
		);
		expect(results.map((r) => r.id)).toEqual(["a"]);
		expect(results[0].field).toBe("frontmatter");
	});

	it("returns a body snippet containing the matched text", () => {
		const long = "x".repeat(200) + " the rate limiter rejects the request " + "y".repeat(200);
		const results = searchVaultDocuments([doc({ id: "a", title: "Untitled", body: long })], "limiter");

		expect(results).toHaveLength(1);
		expect(results[0].field).toBe("body");
		expect(results[0].snippet).toContain("limiter");
		expect(results[0].snippet.length).toBeLessThan(long.length);
	});

	it("filters by type when given", () => {
		const req = doc({ id: "req", title: "login", type: "requirement" });
		const note = doc({ id: "note", title: "login", type: "note" });

		const results = searchVaultDocuments([req, note], "login", { type: "note" });

		expect(results.map((r) => r.id)).toEqual(["note"]);
	});

	it("respects the limit option after ranking", () => {
		const docs = Array.from({ length: 5 }, (_, i) => doc({ id: `d${i}`, title: `login candidate ${i}` }));
		const results = searchVaultDocuments(docs, "login", { limit: 2 });
		expect(results).toHaveLength(2);
	});

	it("breaks score ties by most-recently-updated", () => {
		const older = doc({ id: "older", title: "login", updatedAt: 100 });
		const newer = doc({ id: "newer", title: "login", updatedAt: 200 });

		const results = searchVaultDocuments([older, newer], "login");

		expect(results.map((r) => r.id)).toEqual(["newer", "older"]);
	});
});

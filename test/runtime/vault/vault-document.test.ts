import { describe, expect, it } from "vitest";

import {
	extractWikilinks,
	parseVaultDocument,
	serializeVaultDocument,
	slugify,
	type VaultDocument,
	VaultDocumentParseError,
} from "../../../src/vault/vault-document";

describe("parseVaultDocument", () => {
	it("promotes _id and type and keeps the rest as frontmatter", () => {
		const raw = [
			"---",
			"_id: a1b2c",
			"type: requirement",
			"title: Rate-limit login",
			"status: proposed",
			"---",
			"The login endpoint needs a rate limit.",
			"",
		].join("\n");

		const doc = parseVaultDocument(raw);

		expect(doc.id).toBe("a1b2c");
		expect(doc.type).toBe("requirement");
		expect(doc.frontmatter).toEqual({ title: "Rate-limit login", status: "proposed" });
		expect(doc.body.trim()).toBe("The login endpoint needs a rate limit.");
	});

	it("parses scalar-array frontmatter values", () => {
		const raw = [
			"---",
			"_id: a1",
			"type: requirement",
			"related_tasks:",
			"  - task-7f3a9",
			"  - task-22b1c",
			"---",
			"body",
		].join("\n");

		const doc = parseVaultDocument(raw);

		expect(doc.frontmatter.related_tasks).toEqual(["task-7f3a9", "task-22b1c"]);
	});

	it("throws VaultDocumentParseError when _id is missing", () => {
		const raw = ["---", "type: requirement", "---", "body"].join("\n");

		expect(() => parseVaultDocument(raw)).toThrow(VaultDocumentParseError);
	});

	it("throws VaultDocumentParseError when type is missing", () => {
		const raw = ["---", "_id: a1", "---", "body"].join("\n");

		expect(() => parseVaultDocument(raw)).toThrow(VaultDocumentParseError);
	});
});

describe("serializeVaultDocument", () => {
	const doc: VaultDocument = {
		id: "a1b2c",
		type: "requirement",
		frontmatter: { title: "Rate-limit login", status: "proposed", priority: "high" },
		body: "The login endpoint needs a rate limit.",
	};

	it("round-trips through parse", () => {
		expect(parseVaultDocument(serializeVaultDocument(doc))).toEqual(doc);
	});

	it("emits _id and type before other keys", () => {
		const lines = serializeVaultDocument(doc).split("\n");
		expect(lines[0]).toBe("---");
		expect(lines[1]).toBe("_id: a1b2c");
		expect(lines[2]).toBe("type: requirement");
	});

	it("is deterministic regardless of frontmatter key insertion order", () => {
		const reordered: VaultDocument = {
			...doc,
			frontmatter: { priority: "high", status: "proposed", title: "Rate-limit login" },
		};
		expect(serializeVaultDocument(reordered)).toBe(serializeVaultDocument(doc));
	});

	it("is idempotent: re-serializing a parsed document yields identical bytes", () => {
		const once = serializeVaultDocument(doc);
		expect(serializeVaultDocument(parseVaultDocument(once))).toBe(once);
	});
});

describe("extractWikilinks", () => {
	it("extracts targets from a string, stripping the display label", () => {
		expect(extractWikilinks("see [[acme-corp]] and [[bob|Bob Smith]]")).toEqual(["acme-corp", "bob"]);
	});

	it("extracts targets from a scalar array", () => {
		expect(extractWikilinks(["[[acme-corp]]", "[[globex]]"])).toEqual(["acme-corp", "globex"]);
	});

	it("de-duplicates while preserving first-seen order", () => {
		expect(extractWikilinks("[[a]] [[b]] [[a]]")).toEqual(["a", "b"]);
	});

	it("returns an empty array for non-string values", () => {
		expect(extractWikilinks(42)).toEqual([]);
		expect(extractWikilinks(null)).toEqual([]);
	});
});

describe("slugify", () => {
	it("lowercases and replaces runs of punctuation/space with a single dash", () => {
		expect(slugify("Rate-limit login!")).toBe("rate-limit-login");
	});

	it("preserves unicode letters and numbers", () => {
		expect(slugify("登录限流 v2")).toBe("登录限流-v2");
	});

	it("falls back to 'untitled' when nothing usable remains", () => {
		expect(slugify("   ")).toBe("untitled");
		expect(slugify("!!!")).toBe("untitled");
	});
});

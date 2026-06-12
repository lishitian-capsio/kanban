import { describe, expect, it } from "vitest";

import {
	applyWikilinkCompletion,
	detectActiveWikilinkToken,
	wikilinkLabelPart,
	wikilinkSearchTerm,
} from "./wikilink-completion";

describe("detectActiveWikilinkToken", () => {
	it("detects an open wikilink with the cursor at its end", () => {
		const value = "See [[Acme";
		expect(detectActiveWikilinkToken(value, value.length)).toEqual({
			start: 4,
			end: value.length,
			query: "Acme",
		});
	});

	it("detects an empty query right after the opening brackets", () => {
		const value = "Intro [[";
		expect(detectActiveWikilinkToken(value, value.length)).toEqual({
			start: 6,
			end: value.length,
			query: "",
		});
	});

	it("keeps spaces in the query so multi-word titles can be searched", () => {
		const value = "ref [[Big Customer";
		expect(detectActiveWikilinkToken(value, value.length)?.query).toBe("Big Customer");
	});

	it("keeps the label part in the query", () => {
		const value = "ref [[Acme|the cli";
		expect(detectActiveWikilinkToken(value, value.length)?.query).toBe("Acme|the cli");
	});

	it("returns null once the link is closed before the cursor", () => {
		const value = "done [[Acme]]";
		expect(detectActiveWikilinkToken(value, value.length)).toBeNull();
	});

	it("returns null when there is no opening before the cursor", () => {
		expect(detectActiveWikilinkToken("plain text", 5)).toBeNull();
	});

	it("does not span across a newline", () => {
		const value = "[[\nnext line";
		expect(detectActiveWikilinkToken(value, value.length)).toBeNull();
	});

	it("tracks the nearest opening when several links exist", () => {
		const value = "[[First]] middle [[Sec";
		expect(detectActiveWikilinkToken(value, value.length)).toEqual({
			start: 17,
			end: value.length,
			query: "Sec",
		});
	});

	it("uses the cursor position, not the end of the value", () => {
		const value = "[[Acme]] trailing";
		// Cursor before the closing `]]` re-opens the link for re-completion; only
		// the text before the cursor is inspected (the `]]` is after it).
		expect(detectActiveWikilinkToken(value, 6)).toEqual({ start: 0, end: 6, query: "Acme" });
	});

	it("ignores a single unpaired bracket", () => {
		expect(detectActiveWikilinkToken("array[0", 7)).toBeNull();
	});
});

describe("wikilinkSearchTerm / wikilinkLabelPart", () => {
	it("returns the target portion before the pipe", () => {
		expect(wikilinkSearchTerm("Acme|the cli")).toBe("Acme");
		expect(wikilinkSearchTerm("  Acme  ")).toBe("Acme");
	});

	it("returns the trimmed label after the pipe, or undefined", () => {
		expect(wikilinkLabelPart("Acme|the cli")).toBe("the cli");
		expect(wikilinkLabelPart("Acme|")).toBeUndefined();
		expect(wikilinkLabelPart("Acme")).toBeUndefined();
	});
});

describe("applyWikilinkCompletion", () => {
	it("completes an open link and closes the brackets", () => {
		const value = "See [[Acm";
		const token = detectActiveWikilinkToken(value, value.length)!;
		expect(applyWikilinkCompletion(value, token, "Acme Corp")).toEqual({
			value: "See [[Acme Corp]]",
			cursor: "See [[Acme Corp]]".length,
		});
	});

	it("inserts a label when one is provided", () => {
		const value = "See [[Acme|cli";
		const token = detectActiveWikilinkToken(value, value.length)!;
		expect(applyWikilinkCompletion(value, token, "Acme Corp", "cli")).toEqual({
			value: "See [[Acme Corp|cli]]",
			cursor: "See [[Acme Corp|cli]]".length,
		});
	});

	it("omits a label that equals the target", () => {
		const value = "See [[Acme Corp";
		const token = detectActiveWikilinkToken(value, value.length)!;
		expect(applyWikilinkCompletion(value, token, "Acme Corp", "Acme Corp").value).toBe("See [[Acme Corp]]");
	});

	it("consumes an existing closing bracket pair after the cursor", () => {
		const value = "See [[Acm]] tail";
		const token = detectActiveWikilinkToken(value, 9)!; // cursor right before "]]"
		expect(applyWikilinkCompletion(value, token, "Acme Corp")).toEqual({
			value: "See [[Acme Corp]] tail",
			cursor: "See [[Acme Corp]]".length,
		});
	});

	it("preserves text that follows the completed link", () => {
		const value = "a [[b and more";
		const token = detectActiveWikilinkToken(value, 5)!; // cursor after "[[b"
		const result = applyWikilinkCompletion(value, token, "Beta");
		expect(result.value).toBe("a [[Beta]] and more");
	});
});

import { describe, expect, it } from "vitest";

import { appendTextToDraft } from "./draft-text";

describe("appendTextToDraft", () => {
	it("returns the trimmed text when the draft is empty", () => {
		expect(appendTextToDraft("", "hello")).toBe("hello");
		expect(appendTextToDraft("   ", "hello")).toBe("hello");
	});

	it("appends with a blank line when the draft has content", () => {
		expect(appendTextToDraft("first line", "second")).toBe("first line\n\nsecond");
	});

	it("leaves the draft unchanged for empty text", () => {
		expect(appendTextToDraft("keep me", "   ")).toBe("keep me");
	});
});

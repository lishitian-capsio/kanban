import { describe, expect, it } from "vitest";

import { deriveReviewQuestion } from "../../../src/session/review-question";

describe("deriveReviewQuestion", () => {
	it("returns the closing message when entering review", () => {
		expect(deriveReviewQuestion("awaiting_review", "I did X. Should I do Y next?", null)).toBe(
			"I did X. Should I do Y next?",
		);
	});

	it("trims surrounding whitespace from the closing message", () => {
		expect(deriveReviewQuestion("awaiting_review", "  pick A or B  \n", null)).toBe("pick A or B");
	});

	it("keeps the previously captured question when no fresh message arrives in review", () => {
		expect(deriveReviewQuestion("awaiting_review", null, "earlier question")).toBe("earlier question");
	});

	it("prefers a fresh non-empty message over the previous one", () => {
		expect(deriveReviewQuestion("awaiting_review", "newer", "older")).toBe("newer");
	});

	it("ignores a blank fresh message and falls back to the previous question", () => {
		expect(deriveReviewQuestion("awaiting_review", "   ", "older")).toBe("older");
	});

	it("clears the question once the task leaves review (running)", () => {
		expect(deriveReviewQuestion("running", "still here", "older")).toBeNull();
	});

	it("clears the question for idle/failed states", () => {
		expect(deriveReviewQuestion("idle", "x", "y")).toBeNull();
		expect(deriveReviewQuestion("failed", "x", "y")).toBeNull();
	});

	it("does not surface a closing message for interrupted turns", () => {
		// An interrupted turn was cut off mid-stream; its trailing text is not a
		// deliberate closing question, so it must not be presented as one.
		expect(deriveReviewQuestion("interrupted", "partial...", null)).toBeNull();
	});

	it("returns null when there is neither a fresh nor a previous message in review", () => {
		expect(deriveReviewQuestion("awaiting_review", null, null)).toBeNull();
		expect(deriveReviewQuestion("awaiting_review", undefined, undefined)).toBeNull();
	});
});

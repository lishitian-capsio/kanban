import { describe, expect, it } from "vitest";

import { type AutoReviewFailure, shouldSkipAfterFailure } from "@/git-actions/auto-review-retry";

describe("shouldSkipAfterFailure", () => {
	it("does not skip when there is no recorded failure", () => {
		expect(shouldSkipAfterFailure(undefined, "commit", 3)).toBe(false);
	});

	it("skips a retry for the same action and unchanged working-tree signature", () => {
		const failure: AutoReviewFailure = { action: "commit", changedFiles: 3 };
		expect(shouldSkipAfterFailure(failure, "commit", 3)).toBe(true);
	});

	it("re-arms when the diff changes (new changedFiles count)", () => {
		const failure: AutoReviewFailure = { action: "commit", changedFiles: 3 };
		expect(shouldSkipAfterFailure(failure, "commit", 5)).toBe(false);
	});

	it("re-arms when the action changes", () => {
		const failure: AutoReviewFailure = { action: "commit", changedFiles: 3 };
		expect(shouldSkipAfterFailure(failure, "pr", 3)).toBe(false);
	});
});

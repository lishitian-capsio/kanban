import { describe, expect, it } from "vitest";

import {
	appendMentionToPrompt,
	removeMentionFromPrompt,
} from "@/components/prompt-attachments/prompt-attachment-mentions";

describe("appendMentionToPrompt", () => {
	it("appends directly when the prompt is empty", () => {
		expect(appendMentionToPrompt("", "@/a/b.txt ")).toBe("@/a/b.txt ");
	});

	it("inserts a separating space when the prompt does not end in whitespace", () => {
		expect(appendMentionToPrompt("look at", "@/a/b.txt ")).toBe("look at @/a/b.txt ");
	});

	it("does not double the separator when the prompt already ends in whitespace", () => {
		expect(appendMentionToPrompt("look at ", "@/a/b.txt ")).toBe("look at @/a/b.txt ");
	});
});

describe("removeMentionFromPrompt", () => {
	it("removes the first exact occurrence of the mention", () => {
		expect(removeMentionFromPrompt("look at @/a/b.txt more", "@/a/b.txt ")).toBe("look at more");
	});

	it("falls back to the space-trimmed mention when the trailing space was edited away", () => {
		expect(removeMentionFromPrompt("look at @/a/b.txt", "@/a/b.txt ")).toBe("look at ");
	});

	it("leaves the prompt unchanged when the mention is absent", () => {
		expect(removeMentionFromPrompt("nothing here", "@/a/b.txt ")).toBe("nothing here");
	});
});

import { describe, expect, it } from "vitest";

import type { SessionMessage } from "../../../src/session/session-message";
import { renderTranscriptToMarkdown, selectTranscriptMessages } from "../../../src/vault/crystallize";

function message(role: SessionMessage["role"], content: string, createdAt = 0): SessionMessage {
	return { id: `${role}-${createdAt}`, role, content, createdAt };
}

describe("selectTranscriptMessages", () => {
	const transcript: SessionMessage[] = [
		message("user", "first", 1),
		message("assistant", "reply one", 2),
		message("user", "second", 3),
		message("assistant", "reply two", 4),
	];

	it("returns the whole thread by default", () => {
		expect(selectTranscriptMessages(transcript, {})).toHaveLength(4);
	});

	it("keeps only the trailing N messages when lastN is set", () => {
		const selected = selectTranscriptMessages(transcript, { lastN: 2 });
		expect(selected.map((m) => m.content)).toEqual(["second", "reply two"]);
	});

	it("returns the whole thread when lastN exceeds the message count", () => {
		expect(selectTranscriptMessages(transcript, { lastN: 99 })).toHaveLength(4);
	});

	it("treats a non-positive lastN as the whole thread", () => {
		expect(selectTranscriptMessages(transcript, { lastN: 0 })).toHaveLength(4);
	});
});

describe("renderTranscriptToMarkdown", () => {
	it("renders user and assistant turns as labelled sections", () => {
		const { title, body } = renderTranscriptToMarkdown([
			message("user", "How should we rate-limit login?", 1),
			message("assistant", "Use a token bucket per account.", 2),
		]);
		expect(title).toBe("How should we rate-limit login?");
		expect(body).toContain("**User:**");
		expect(body).toContain("How should we rate-limit login?");
		expect(body).toContain("**Assistant:**");
		expect(body).toContain("Use a token bucket per account.");
	});

	it("drops noise roles (tool/reasoning/status/system) and empty content", () => {
		const { body } = renderTranscriptToMarkdown([
			message("user", "question", 1),
			message("reasoning", "thinking...", 2),
			message("tool", "ran a tool", 3),
			message("status", "interrupted", 4),
			message("system", "system note", 5),
			message("assistant", "   ", 6),
			message("assistant", "answer", 7),
		]);
		expect(body).not.toContain("thinking");
		expect(body).not.toContain("ran a tool");
		expect(body).not.toContain("interrupted");
		expect(body).not.toContain("system note");
		expect(body).toContain("question");
		expect(body).toContain("answer");
		// The blank assistant turn is omitted, so only one assistant label remains.
		expect(body.match(/\*\*Assistant:\*\*/g)).toHaveLength(1);
	});

	it("prefers an explicit title over the derived one", () => {
		const { title } = renderTranscriptToMarkdown([message("user", "derived", 1)], { title: "Explicit" });
		expect(title).toBe("Explicit");
	});

	it("derives a title from the first line of the first user message, truncating long ones", () => {
		const long = "a".repeat(200);
		const { title } = renderTranscriptToMarkdown([message("user", `${long}\nsecond line`, 1)]);
		expect(title.length).toBeLessThanOrEqual(80);
		expect(title.startsWith("aaaa")).toBe(true);
	});

	it("falls back to a default title when there is no usable user content", () => {
		const { title } = renderTranscriptToMarkdown([message("assistant", "only an answer", 1)]);
		expect(title).toBe("Untitled note");
	});

	it("produces an empty body for an all-noise transcript", () => {
		const { body } = renderTranscriptToMarkdown([message("status", "x", 1), message("tool", "y", 2)]);
		expect(body).toBe("");
	});
});

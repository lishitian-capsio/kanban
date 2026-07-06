import { describe, expect, it } from "vitest";

import { appendAttachmentMentionsToPrompt } from "../../../src/terminal/task-attachment-prompt";

describe("appendAttachmentMentionsToPrompt", () => {
	it("returns the prompt unchanged when there are no attachment paths", () => {
		expect(appendAttachmentMentionsToPrompt("do the thing", [])).toBe("do the thing");
	});

	it("ignores blank paths", () => {
		expect(appendAttachmentMentionsToPrompt("hi", ["   ", ""])).toBe("hi");
	});

	it("appends a single `@`-mention section separated by a blank line", () => {
		expect(appendAttachmentMentionsToPrompt("read this", ["/repo/.kanban/attachments/t/report-1234.pdf"])).toBe(
			"read this\n\nAttached files: @/repo/.kanban/attachments/t/report-1234.pdf",
		);
	});

	it("joins multiple mentions with a space", () => {
		expect(appendAttachmentMentionsToPrompt("x", ["/a/one.pdf", "/a/two.md"])).toBe(
			"x\n\nAttached files: @/a/one.pdf @/a/two.md",
		);
	});

	it("quotes paths that contain spaces", () => {
		expect(appendAttachmentMentionsToPrompt("x", ["/a b/c d.pdf"])).toBe('x\n\nAttached files: @"/a b/c d.pdf"');
	});

	it("emits only the section when the prompt is empty", () => {
		expect(appendAttachmentMentionsToPrompt("   ", ["/a/one.pdf"])).toBe("Attached files: @/a/one.pdf");
	});
});

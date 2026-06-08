import { describe, expect, it } from "vitest";

import {
	applyKanbanComposerCompletion,
	buildMentionInsertText,
	buildSlashCommandInsertText,
	detectActiveKanbanComposerToken,
} from "@/components/detail-panels/kanban-chat-composer-completion";

describe("kanban-chat-composer-completion", () => {
	it("detects active mention tokens at the cursor", () => {
		expect(detectActiveKanbanComposerToken("Review @src/comp", "Review @src/comp".length)).toEqual({
			kind: "mention",
			start: 7,
			end: 16,
			query: "src/comp",
		});
	});

	it("detects active slash tokens at the start of the draft", () => {
		expect(detectActiveKanbanComposerToken("/con", 4)).toEqual({
			kind: "slash",
			start: 0,
			end: 4,
			query: "con",
		});
	});

	it("ignores inline markers that are not token boundaries", () => {
		expect(detectActiveKanbanComposerToken("foo/bar", "foo/bar".length)).toBeNull();
		expect(detectActiveKanbanComposerToken("mail@test", "mail@test".length)).toBeNull();
	});

	it("formats mention insert text with quotes when needed", () => {
		expect(buildMentionInsertText("src/app.ts")).toBe("@/src/app.ts");
		expect(buildMentionInsertText("docs/my file.md")).toBe('@"/docs/my file.md"');
	});

	it("formats slash command insert text", () => {
		expect(buildSlashCommandInsertText("config")).toBe("/config");
	});

	it("applies a completion and preserves trailing content", () => {
		const token = detectActiveKanbanComposerToken("/con next", 4);
		expect(token).not.toBeNull();
		const next = applyKanbanComposerCompletion("/con next", token!, "/config");
		expect(next).toEqual({
			value: "/config next",
			cursor: 7,
		});
	});
});

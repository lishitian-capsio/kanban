import { describe, expect, it } from "vitest";
import type { SessionMessage } from "../../../src/session/session-message";
import {
	capChatMessagesForTransport,
	MAX_DISPLAY_CONTENT_CHARS,
} from "../../../src/session/session-message-display-cap";

function message(id: string, content: string, role: SessionMessage["role"] = "assistant"): SessionMessage {
	return { id, role, content, createdAt: 1 };
}

describe("capChatMessagesForTransport", () => {
	it("leaves messages under the cap untouched and returns the same references", () => {
		const messages = [message("a", "short"), message("b", "x".repeat(MAX_DISPLAY_CONTENT_CHARS))];
		const capped = capChatMessagesForTransport(messages);
		// Same message object references are reused when nothing is truncated, so
		// downstream identity checks (and the merge cache) keep working.
		expect(capped[0]).toBe(messages[0]);
		expect(capped[1]).toBe(messages[1]);
	});

	it("truncates oversized content and flags it in meta", () => {
		const huge = "y".repeat(MAX_DISPLAY_CONTENT_CHARS + 5_000_000);
		const capped = capChatMessagesForTransport([message("big", huge, "tool")]);
		const out = capped[0];
		expect(out).toBeDefined();
		expect(out?.id).toBe("big");
		expect(out?.role).toBe("tool");
		// Head is preserved up to the cap; total stays bounded (head + short marker).
		expect(out?.content.length).toBeLessThan(MAX_DISPLAY_CONTENT_CHARS + 500);
		expect(out?.content.startsWith("y".repeat(1000))).toBe(true);
		expect(out?.meta?.contentTruncated).toBe(true);
		expect(out?.meta?.originalContentLength).toBe(huge.length);
	});

	it("preserves existing meta fields when truncating", () => {
		const huge = "z".repeat(MAX_DISPLAY_CONTENT_CHARS * 2);
		const msg: SessionMessage = {
			id: "t",
			role: "tool",
			content: huge,
			createdAt: 2,
			meta: { toolName: "search_files", messageKind: "tool_result" },
		};
		const out = capChatMessagesForTransport([msg])[0];
		expect(out?.meta?.toolName).toBe("search_files");
		expect(out?.meta?.messageKind).toBe("tool_result");
		expect(out?.meta?.contentTruncated).toBe(true);
		// The original message object is not mutated.
		expect(msg.content.length).toBe(huge.length);
		expect(msg.meta?.contentTruncated).toBeUndefined();
	});

	it("returns the same array reference when no message needs capping", () => {
		const messages = [message("a", "one"), message("b", "two")];
		expect(capChatMessagesForTransport(messages)).toBe(messages);
	});
});

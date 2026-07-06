import { describe, expect, it } from "vitest";

import { agentSupportsFileAttachments } from "../../../src/terminal/attachment-agents";

describe("agentSupportsFileAttachments (backend)", () => {
	it("accepts claude", () => {
		expect(agentSupportsFileAttachments("claude")).toBe(true);
	});

	it("rejects other agents and nullish ids", () => {
		expect(agentSupportsFileAttachments("codex")).toBe(false);
		expect(agentSupportsFileAttachments("pi")).toBe(false);
		expect(agentSupportsFileAttachments(null)).toBe(false);
		expect(agentSupportsFileAttachments(undefined)).toBe(false);
	});
});

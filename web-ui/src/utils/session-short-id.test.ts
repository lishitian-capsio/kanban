import { describe, expect, it } from "vitest";

import { deriveSessionShortId, SESSION_SHORT_ID_LENGTH } from "@/utils/session-short-id";

describe("deriveSessionShortId", () => {
	it("is deterministic for the same session id", () => {
		const id = "__home_agent__:ws-1:pi:thread-abc";
		expect(deriveSessionShortId(id)).toBe(deriveSessionShortId(id));
	});

	it("always returns a fixed-length uppercase base36 code", () => {
		for (const id of ["__home_agent__:ws-1:pi", "__home_agent__:ws-1:claude:x", "a", ""]) {
			const code = deriveSessionShortId(id);
			expect(code).toHaveLength(SESSION_SHORT_ID_LENGTH);
			expect(code).toMatch(/^[0-9A-Z]+$/);
		}
	});

	it("ignores surrounding whitespace (same code as the trimmed id)", () => {
		const id = "__home_agent__:ws-1:pi:thread-abc";
		expect(deriveSessionShortId(`  ${id}  `)).toBe(deriveSessionShortId(id));
	});

	it("gives distinct codes to the sessions sharing a workspace (legacy default + created threads)", () => {
		const ids = [
			"__home_agent__:ws-1:pi", // legacy 3-segment default thread
			"__home_agent__:ws-1:claude", // different agent, default thread
			"__home_agent__:ws-1:pi:thread-1", // created thread
			"__home_agent__:ws-1:pi:thread-2",
			"__home_agent__:ws-1:claude:thread-1",
		];
		const codes = ids.map(deriveSessionShortId);
		expect(new Set(codes).size).toBe(ids.length);
	});
});

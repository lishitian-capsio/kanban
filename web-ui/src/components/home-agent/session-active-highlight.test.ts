import { describe, expect, it } from "vitest";

import { getActiveHighlightClass } from "@/components/home-agent/session-active-highlight";

describe("getActiveHighlightClass", () => {
	it("uses an accent border for the active tile (card)", () => {
		expect(getActiveHighlightClass("card", true)).toContain("border-accent");
		expect(getActiveHighlightClass("card", false)).not.toContain("border-accent");
		expect(getActiveHighlightClass("card", false)).toContain("border-border");
	});

	it("uses an accent bottom underline + surface-2 for the active tab", () => {
		const active = getActiveHighlightClass("tab", true);
		expect(active).toContain("border-b-2");
		expect(active).toContain("border-accent");
		expect(active).toContain("bg-surface-2");
		// Inactive reserves the same border footprint so toggling active never shifts content.
		const inactive = getActiveHighlightClass("tab", false);
		expect(inactive).toContain("border-b-2");
		expect(inactive).toContain("border-transparent");
		expect(inactive).not.toContain("border-accent");
	});

	it("uses an accent left bar + surface-2 for the active dropdown item and rail item", () => {
		for (const variant of ["dropdown-item", "rail-item"] as const) {
			const active = getActiveHighlightClass(variant, true);
			expect(active).toContain("border-l-2");
			expect(active).toContain("border-accent");
			expect(active).toContain("bg-surface-2");
			const inactive = getActiveHighlightClass(variant, false);
			expect(inactive).toContain("border-l-2");
			expect(inactive).toContain("border-transparent");
			expect(inactive).not.toContain("border-accent");
		}
	});
});

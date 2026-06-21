import { describe, expect, it } from "vitest";

import { getTaskOwnerLabel, getTaskOwnerTooltip } from "@/utils/task-owner";

describe("getTaskOwnerLabel", () => {
	it("prefers the name, falls back to the email", () => {
		expect(getTaskOwnerLabel({ name: "Ada", email: "ada@example.com" })).toBe("Ada");
		expect(getTaskOwnerLabel({ name: "", email: "ada@example.com" })).toBe("ada@example.com");
		expect(getTaskOwnerLabel(undefined)).toBe("");
	});
});

describe("getTaskOwnerTooltip", () => {
	it("shows the full git identity as `Name <email>` when both are present", () => {
		expect(getTaskOwnerTooltip({ name: "Ada", email: "ada@example.com" })).toBe("Ada <ada@example.com>");
	});

	it("falls back to whichever field is present alone", () => {
		expect(getTaskOwnerTooltip({ name: "Ada", email: "" })).toBe("Ada");
		expect(getTaskOwnerTooltip({ name: "", email: "ada@example.com" })).toBe("ada@example.com");
	});

	it("returns an empty string for a missing or blank owner", () => {
		expect(getTaskOwnerTooltip(undefined)).toBe("");
		expect(getTaskOwnerTooltip({ name: "  ", email: " " })).toBe("");
	});
});

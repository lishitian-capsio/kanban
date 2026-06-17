import { describe, expect, it } from "vitest";
import { isLevelEnabled, resolveLogLevel } from "../../src/logging/log-level";

describe("resolveLogLevel", () => {
	it("defaults to info when no env is set", () => {
		expect(resolveLogLevel({})).toBe("info");
	});

	it("honors an explicit KANBAN_LOG_LEVEL", () => {
		expect(resolveLogLevel({ KANBAN_LOG_LEVEL: "warn" })).toBe("warn");
	});

	it("is case-insensitive and trims KANBAN_LOG_LEVEL", () => {
		expect(resolveLogLevel({ KANBAN_LOG_LEVEL: "  DEBUG " })).toBe("debug");
	});

	it("falls back to info for an unrecognized KANBAN_LOG_LEVEL", () => {
		expect(resolveLogLevel({ KANBAN_LOG_LEVEL: "loud" })).toBe("info");
	});

	it("drops to debug when KANBAN_DEBUG_MODE is truthy", () => {
		expect(resolveLogLevel({ KANBAN_DEBUG_MODE: "1" })).toBe("debug");
	});

	it("lets an explicit level win over KANBAN_DEBUG_MODE", () => {
		expect(resolveLogLevel({ KANBAN_LOG_LEVEL: "error", KANBAN_DEBUG_MODE: "1" })).toBe("error");
	});

	it("treats KANBAN_DEBUG_MODE=0 / false / empty as not enabled", () => {
		expect(resolveLogLevel({ KANBAN_DEBUG_MODE: "0" })).toBe("info");
		expect(resolveLogLevel({ KANBAN_DEBUG_MODE: "false" })).toBe("info");
		expect(resolveLogLevel({ KANBAN_DEBUG_MODE: "" })).toBe("info");
	});
});

describe("isLevelEnabled", () => {
	it("enables a candidate at or above the threshold", () => {
		expect(isLevelEnabled("warn", "info")).toBe(true);
		expect(isLevelEnabled("info", "info")).toBe(true);
		expect(isLevelEnabled("error", "warn")).toBe(true);
	});

	it("disables a candidate below the threshold", () => {
		expect(isLevelEnabled("debug", "info")).toBe(false);
		expect(isLevelEnabled("info", "warn")).toBe(false);
	});
});

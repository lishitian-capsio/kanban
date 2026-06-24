import { describe, expect, it, vi } from "vitest";

import { resolvePasscode } from "../../../src/security/passcode-resolver";

describe("resolvePasscode priority", () => {
	it("prefers an explicit passcode over a persisted one and never generates", () => {
		const generate = vi.fn(() => "GENERATED");
		const result = resolvePasscode({ explicit: "EXPLICIT1", persisted: "PERSISTED", generate });
		expect(result).toEqual({ value: "EXPLICIT1", source: "explicit" });
		expect(generate).not.toHaveBeenCalled();
	});

	it("reuses the persisted passcode when no explicit one is given", () => {
		const generate = vi.fn(() => "GENERATED");
		const result = resolvePasscode({ explicit: null, persisted: "PERSISTED", generate });
		expect(result).toEqual({ value: "PERSISTED", source: "persisted" });
		expect(generate).not.toHaveBeenCalled();
	});

	it("generates a fresh passcode when neither explicit nor persisted is available", () => {
		const generate = vi.fn(() => "GENERATED");
		const result = resolvePasscode({ explicit: null, persisted: null, generate });
		expect(result).toEqual({ value: "GENERATED", source: "generated" });
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it("treats blank/whitespace explicit and persisted values as absent", () => {
		const generate = vi.fn(() => "GENERATED");
		expect(resolvePasscode({ explicit: "   ", persisted: "  ", generate })).toEqual({
			value: "GENERATED",
			source: "generated",
		});
		expect(resolvePasscode({ explicit: "", persisted: "PERSISTED", generate })).toEqual({
			value: "PERSISTED",
			source: "persisted",
		});
	});

	it("trims surrounding whitespace from the chosen value", () => {
		const generate = vi.fn(() => "GENERATED");
		expect(resolvePasscode({ explicit: "  spaced  ", persisted: null, generate })).toEqual({
			value: "spaced",
			source: "explicit",
		});
	});
});

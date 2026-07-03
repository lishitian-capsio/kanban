import { describe, expect, it } from "vitest";

import { CliError } from "../../src/commands/cli-envelope";
import { assertStorageAccessEnabled } from "../../src/commands/storage";

describe("assertStorageAccessEnabled — per-workspace CLI access gate", () => {
	it("throws storage_access_disabled when the switch is off", () => {
		try {
			assertStorageAccessEnabled({ agentStorageAccessEnabled: false });
			throw new Error("expected assertStorageAccessEnabled to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).code).toBe("storage_access_disabled");
		}
	});

	it("passes through (does not throw) when the switch is on", () => {
		expect(() => assertStorageAccessEnabled({ agentStorageAccessEnabled: true })).not.toThrow();
	});
});

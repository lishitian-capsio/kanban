// test/runtime/storage/storage-access-gate.test.ts
import { describe, expect, it } from "vitest";
import { runtimeVaultSettingsSchema, runtimeVaultSettingsUpdateRequestSchema } from "../../../src/core/api-contract";

describe("agentStorageAccessEnabled", () => {
	it("defaults to false", () => {
		expect(runtimeVaultSettingsSchema.parse({}).agentStorageAccessEnabled).toBe(false);
	});
	it("is an optional boolean in the update request", () => {
		expect(runtimeVaultSettingsUpdateRequestSchema.parse({ agentStorageAccessEnabled: true }).agentStorageAccessEnabled).toBe(true);
		expect(runtimeVaultSettingsUpdateRequestSchema.parse({}).agentStorageAccessEnabled).toBeUndefined();
	});
});

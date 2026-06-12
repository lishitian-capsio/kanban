import { describe, expect, it } from "vitest";

import {
	buildCopyProfileName,
	buildNewProfileName,
	duplicateProfileCreateInput,
	selectProfileForAgent,
} from "@/hooks/agent-profile-utils";
import type { RuntimeAgentProfile } from "@/runtime/types";

function profile(overrides: Partial<RuntimeAgentProfile> & Pick<RuntimeAgentProfile, "id" | "name">): RuntimeAgentProfile {
	return {
		agentId: "pi",
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		baseUrl: null,
		reasoningEffort: null,
		region: null,
		gcpProjectId: null,
		gcpRegion: null,
		apiKeyConfigured: false,
		...overrides,
	};
}

describe("selectProfileForAgent", () => {
	it("returns the profile referenced by selectedByAgent for the agent", () => {
		const profiles = [profile({ id: "a", name: "A" }), profile({ id: "b", name: "B" })];
		expect(selectProfileForAgent(profiles, { pi: "b" }, "pi")?.id).toBe("b");
	});

	it("returns null when no selection exists for the agent", () => {
		const profiles = [profile({ id: "a", name: "A" })];
		expect(selectProfileForAgent(profiles, {}, "pi")).toBeNull();
	});

	it("returns null when the selected id is dangling", () => {
		const profiles = [profile({ id: "a", name: "A" })];
		expect(selectProfileForAgent(profiles, { pi: "gone" }, "pi")).toBeNull();
	});

	it("ignores a selection that points at a different agent's profile", () => {
		const profiles = [profile({ id: "a", name: "A", agentId: "claude" })];
		expect(selectProfileForAgent(profiles, { pi: "a" }, "pi")).toBeNull();
	});
});

describe("buildCopyProfileName", () => {
	it("appends (copy) when free", () => {
		expect(buildCopyProfileName([], "Fast")).toBe("Fast (copy)");
	});

	it("escalates the copy counter on clash (case-insensitive)", () => {
		expect(buildCopyProfileName(["Fast (copy)", "fast (copy 2)"], "Fast")).toBe("Fast (copy 3)");
	});
});

describe("buildNewProfileName", () => {
	it("returns the base when free", () => {
		expect(buildNewProfileName([])).toBe("New profile");
	});

	it("suffixes a counter on clash", () => {
		expect(buildNewProfileName(["New profile", "New profile 2"])).toBe("New profile 3");
	});
});

describe("duplicateProfileCreateInput", () => {
	it("copies non-secret fields, takes the new name, and selects", () => {
		const source = profile({
			id: "a",
			name: "Vertex",
			agentId: "pi",
			providerId: "vertex",
			modelId: "gemini-3-pro",
			reasoningEffort: "high",
			region: "us-east5",
			gcpProjectId: "proj",
			gcpRegion: "us-east5",
		});
		expect(duplicateProfileCreateInput(source, "Vertex (copy)")).toEqual({
			agentId: "pi",
			name: "Vertex (copy)",
			providerId: "vertex",
			modelId: "gemini-3-pro",
			baseUrl: null,
			reasoningEffort: "high",
			region: "us-east5",
			gcpProjectId: "proj",
			gcpRegion: "us-east5",
			select: true,
		});
	});
});
